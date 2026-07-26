import type { Account } from "@thru/sdk";
import { thru } from "../client";
import {
  accountDataBytes,
  assertAccountOwnedBy,
  parseDomainData,
  parseLeaseData,
  parseRegistrarConfigData,
} from "./account-parser";
import type {
  DomainState,
  LeaseState,
  NameLookupSnapshot,
  ReadonlyAccountReader,
  SnapshotAccount,
} from "./account-types";
import {
  NAME_SERVICE_PROGRAM_ADDRESS,
  REGISTRAR_PROGRAM_ADDRESS,
} from "./constants";
import {
  deriveDomainAddress,
  deriveLeaseAddress,
  deriveRegistrarConfigAddress,
} from "./derivation";
import { validateNameLabel } from "./validation";

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

async function abortable<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return operation;

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export const alphaNetReadonlyAccountReader: ReadonlyAccountReader = {
  async get(address, signal) {
    return abortable<Account>(
      thru.accounts.get(address),
      signal,
    );
  },
};

export function isAccountNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    (error as { code?: number } | null)?.code === 5 ||
    /not.?found/i.test(message)
  );
}

async function readOptionalAccount<T>(
  address: string,
  expectedOwner: string,
  label: string,
  parse: (data: Uint8Array) => T,
  reader: ReadonlyAccountReader,
  signal?: AbortSignal,
): Promise<SnapshotAccount<T>> {
  try {
    const account = await reader.get(address, signal);
    signal?.throwIfAborted();
    if (account.meta?.flags?.isDeleted) {
      return { status: "not-found", address };
    }
    assertAccountOwnedBy(account, expectedOwner, label);
    const state = parse(accountDataBytes(account, label));
    return { status: "found", address, state };
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    if (isAccountNotFound(error)) {
      return { status: "not-found", address };
    }
    return {
      status: "invalid",
      address,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function invalidateDomainRelationship(
  account: SnapshotAccount<DomainState>,
  expectedParent: string,
  expectedName: string,
): SnapshotAccount<DomainState> {
  if (account.status !== "found") return account;
  if (account.state.parent !== expectedParent) {
    return {
      status: "invalid",
      address: account.address,
      error: `Domain parent ${account.state.parent} does not match root registrar ${expectedParent}.`,
    };
  }
  if (account.state.name !== expectedName) {
    return {
      status: "invalid",
      address: account.address,
      error: `Domain name ${JSON.stringify(account.state.name)} does not match requested label ${JSON.stringify(expectedName)}.`,
    };
  }
  return account;
}

function invalidateLeaseRelationship(
  account: SnapshotAccount<LeaseState>,
  expectedDomain: string,
  expectedName: string,
): SnapshotAccount<LeaseState> {
  if (account.status !== "found") return account;
  if (account.state.domainAccount !== expectedDomain) {
    return {
      status: "invalid",
      address: account.address,
      error: `Lease domain ${account.state.domainAccount} does not match derived domain ${expectedDomain}.`,
    };
  }
  if (account.state.domainName !== expectedName) {
    return {
      status: "invalid",
      address: account.address,
      error: `Lease name ${JSON.stringify(account.state.domainName)} does not match requested label ${JSON.stringify(expectedName)}.`,
    };
  }
  return account;
}

export async function lookupThruName(
  input: string,
  options: {
    signal?: AbortSignal;
    reader?: ReadonlyAccountReader;
  } = {},
): Promise<NameLookupSnapshot> {
  const { signal, reader = alphaNetReadonlyAccountReader } = options;
  const validated = validateNameLabel(input);
  signal?.throwIfAborted();

  const configAddress = deriveRegistrarConfigAddress();
  const configAccount = await reader.get(configAddress, signal);
  signal?.throwIfAborted();
  if (configAccount.meta?.flags?.isDeleted) {
    throw new Error("The official AlphaNet Registrar config is deleted.");
  }
  assertAccountOwnedBy(
    configAccount,
    REGISTRAR_PROGRAM_ADDRESS,
    "Registrar config",
  );
  const config = parseRegistrarConfigData(
    accountDataBytes(configAccount, "Registrar config"),
  );
  if (config.nameServiceProgramId !== NAME_SERVICE_PROGRAM_ADDRESS) {
    throw new Error(
      `Registrar config points to ${config.nameServiceProgramId}, not the official AlphaNet Name Service program.`,
    );
  }

  const [domainAddress, leaseAddress] = await Promise.all([
    deriveDomainAddress(config.rootRegistrar, validated.bytes),
    deriveLeaseAddress(validated.bytes),
  ]);
  signal?.throwIfAborted();

  const [rawDomain, rawLease] = await Promise.all([
    readOptionalAccount(
      domainAddress,
      NAME_SERVICE_PROGRAM_ADDRESS,
      "Domain account",
      parseDomainData,
      reader,
      signal,
    ),
    readOptionalAccount(
      leaseAddress,
      REGISTRAR_PROGRAM_ADDRESS,
      "Lease account",
      parseLeaseData,
      reader,
      signal,
    ),
  ]);

  let domain = invalidateDomainRelationship(
    rawDomain,
    config.rootRegistrar,
    validated.label,
  );
  let lease = invalidateLeaseRelationship(
    rawLease,
    domainAddress,
    validated.label,
  );

  if (
    domain.status === "found" &&
    lease.status === "found" &&
    domain.state.owner !== lease.state.owner
  ) {
    const mismatch =
      `Domain owner ${domain.state.owner} does not match lease owner ${lease.state.owner}.`;
    domain = { status: "invalid", address: domain.address, error: mismatch };
    lease = { status: "invalid", address: lease.address, error: mismatch };
  }

  return {
    label: validated.label,
    fullyQualifiedName: `${validated.label}.thru`,
    configAddress,
    domainAddress,
    leaseAddress,
    config,
    domain,
    lease,
  };
}

export class LatestNameLookupTracker {
  private latest = 0;

  begin(): number {
    this.latest += 1;
    return this.latest;
  }

  isCurrent(request: number): boolean {
    return request === this.latest;
  }

  invalidate(): void {
    this.latest += 1;
  }
}
