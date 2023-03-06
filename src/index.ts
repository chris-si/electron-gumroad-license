import axios from "axios";
import Store, { Schema } from "electron-store";
import https from "https";
import { machineIdSync } from "node-machine-id";

import {
  GumroadResponse,
  GumroadSuccessResponse,
  Purchase,
} from "./types/gumroad";

const API_URL = "https://api.gumroad.com/v2/licenses/verify";

export interface GumroadLicenseOptions {
  /** Specifies how many times a single license code can be activated. Default: unlimited. */
  maxUses?: number;
  /** Specifies how many days a license stays valid without being validated. Default: unlimited. */
  maxDaysBetweenChecks?: number;
  /** Overrides Gumroad's default API endpoint for verifying licenses. */
  gumroadApiUrl?: string;
  /** Disables encrypting the license key with a unique machine id. */
  disableEncryption?: boolean;
  /** Specifies a timeout in ms for reaching the license servers. Default: 15.000 ms */
  timeout?: number;
  /** Old Electron cert check */
  rejectUnauthorized?: boolean;
}

export enum CheckStatus {
  ValidLicense,
  InvalidLicense,
  OutdatedLicense,
  NotSet,
  UnableToCheck,
}

export enum ErrorType {
  ServerUnavailable,
  ActivationError,
  MaxUseExceeded,
  LicenseRefunded,
  UnknownError,
}

export interface GumroadError {
  type: ErrorType;
  message: string;
}

export interface ILicenseStore {
  license: {
    fileName: string;
    fileExtension: string;
    encryptionKey: string | undefined;
    clearInvalidConfig: boolean;
    key: string;
    lastCheckAttempt: number;
    lastCheckSuccess: number;
    purchase: Purchase;
  };
}

const licenseStoreSchema: Schema<ILicenseStore> = {
  license: {
    type: "object",
    properties: {
      fileName: {
        type: "string",
      },
      fileExtension: {
        type: "string",
      },
      encryptionKey: {
        type: "string",
      },
      clearInvalidConfig: {
        type: "boolean",
      },
      key: {
        type: "string",
      },
      lastCheckAttempt: {
        type: "number",
      },
      lastCheckSuccess: {
        type: "number",
      },
      purchase: {
        type: "object",
        default: {},
      },
    },
    default: {},
  },
};

export type LicenseManager = ReturnType<typeof createLicenseManager>;

type CheckResult =
  | { status: CheckStatus.ValidLicense; response: GumroadSuccessResponse }
  | { status: CheckStatus.InvalidLicense; error: GumroadError }
  | { status: CheckStatus.UnableToCheck; error: any };

/**
 * Creates a new license manager for your product.
 *
 * @param productId your product ID as specified by Gumroad
 */
export const createLicenseManager = (
  productId: string,
  options?: GumroadLicenseOptions,
) => {
  const encryptionKey = productId + machineIdSync();
  const licenseStore = new Store<ILicenseStore>({
    defaults: {
      license: {
        fileName: "license",
        fileExtension: "key",
        encryptionKey: !options?.disableEncryption ? encryptionKey : undefined,
        clearInvalidConfig: true,
        key: undefined!,
        lastCheckAttempt: undefined!,
        lastCheckSuccess: undefined!,
        purchase: undefined!,
      },
    },
    schema: licenseStoreSchema,
    name: "license",
  });

  /**
   * Validates a given license key against Gumroad's API and increases the use
   * count if specified.
   *
   * @param licenseKey the given license key
   * @param increaseUseCount increases the use count if true
   */
  const validateLicenseCode = async (
    licenseKey: string,
    increaseUseCount = false,
  ): Promise<CheckResult> => {
    let result: GumroadResponse;
    if (options?.rejectUnauthorized == false) {
      https.globalAgent.options.rejectUnauthorized = false;
    }

    try {
      result = await axios.post(options?.gumroadApiUrl ?? API_URL, {
        throwHttpErrors: false,
        timeout: { send: options?.timeout ?? 15000 },
        form: {
          product_id: productId,
          license_key: licenseKey.trim(),
          increment_uses_count: increaseUseCount,
        },
      });
    } catch (e) {
      return {
        status: CheckStatus.UnableToCheck,
        error: e,
      };
    }

    if (!result.success) {
      return {
        status: CheckStatus.InvalidLicense,
        error: {
          type: ErrorType.ActivationError,
          message:
            result.message || "License check failed without an error message.",
        },
      };
    }

    // Check whether the purchase has been refunded or chargebacked
    if (
      !result.purchase ||
      result.purchase.refunded ||
      result.purchase.chargebacked
    ) {
      return {
        status: CheckStatus.InvalidLicense,
        error: {
          type: ErrorType.LicenseRefunded,
          message:
            "Your purchase has been refunded, so your license is no longer valid.",
        },
      };
    }

    return {
      status: CheckStatus.ValidLicense,
      response: result,
    };
  };

  /**
   * Validates a new license key against Gumroad's API and stores it locally if
   * it is valid. This increases the use counter for the license.
   *
   * @param licenseKey the license key to check against
   */
  const addLicense = async (
    licenseKey: string,
  ): Promise<
    | { success: true; response: GumroadSuccessResponse }
    | { success: false; error: GumroadError }
  > => {
    if (typeof options?.maxUses !== "undefined") {
      const result = await validateLicenseCode(licenseKey);
      if (
        result.status === CheckStatus.ValidLicense &&
        result.response.uses >= options?.maxUses
      ) {
        return {
          success: false,
          error: {
            type: ErrorType.MaxUseExceeded,
            message: `You have reached the limit of ${options.maxUses} activations.`,
          },
        };
      }
    }

    const result = await validateLicenseCode(licenseKey, true);

    if (result.status === CheckStatus.UnableToCheck) {
      return {
        success: false,
        error: result.error,
      };
    }

    if (result.status === CheckStatus.InvalidLicense) {
      return { success: false, error: result.error };
    }

    licenseStore.set("license.key", licenseKey);
    licenseStore.set("license.lastCheckAttempt", Date.now());
    licenseStore.set("license.lastCheckSuccess", Date.now());
    return { success: true, response: result.response };
  };

  /**
   * Checks the locally stored license. If Gumroad's API can be reached, the
   * license is validated again. Otherwise, the locally stored license is used.
   */
  const checkCurrentLicense = async (): Promise<
    | { status: CheckStatus.ValidLicense; purchase: Purchase }
    | {
        status:
          | CheckStatus.InvalidLicense
          | CheckStatus.OutdatedLicense
          | CheckStatus.NotSet;
      }
  > => {
    const key = licenseStore.get("license.key") as string;

    if (!key) {
      return { status: CheckStatus.NotSet };
    }

    licenseStore.set("license.lastCheckAttempt", Date.now());
    const result = await validateLicenseCode(key);

    switch (result.status) {
      case CheckStatus.ValidLicense:
        licenseStore.set("license.lastCheckSuccess", Date.now());
        licenseStore.set("license.purchase", result.response.purchase);
        return {
          status: CheckStatus.ValidLicense,
          purchase: result.response.purchase,
        };
      case CheckStatus.UnableToCheck:
        const storedPurchase = licenseStore.get("license.purchase") as Purchase;
        const lastCheckSuccess = licenseStore.get("lastCheckSuccess") as number;

        if (
          options?.maxDaysBetweenChecks &&
          (!lastCheckSuccess ||
            Date.now() - lastCheckSuccess >
              86_400_000 * options.maxDaysBetweenChecks)
        ) {
          return { status: CheckStatus.OutdatedLicense };
        }

        return storedPurchase
          ? {
              status: CheckStatus.ValidLicense,
              purchase: storedPurchase,
            }
          : { status: CheckStatus.InvalidLicense };
      case CheckStatus.InvalidLicense:
        // @ts-ignore
        licenseStore.delete("license.purchase");
        return { status: CheckStatus.InvalidLicense };
    }
  };

  /**
   * Clears the stored license.
   */
  const clearLicense = () => {
    licenseStore.clear();
  };

  return { checkCurrentLicense, addLicense, validateLicenseCode, clearLicense };
};
