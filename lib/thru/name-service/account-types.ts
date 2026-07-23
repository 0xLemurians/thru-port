export interface RegistrarConfigState {
  nameServiceProgramId: string;
  rootRegistrar: string;
  treasurerTokenAccount: string;
  paymentMint: string;
  tokenProgramId: string;
  rootDomainName: string;
  pricePerYear: bigint;
  totalDomainsSold: bigint;
}

export interface NameRecord {
  key: string;
  value: string;
  keyByteLength: number;
  valueByteLength: number;
}

export interface DomainState {
  parent: string;
  owner: string;
  name: string;
  registrationTime: bigint;
  recordCount: number;
  records: NameRecord[];
}

export interface LeaseState {
  domainAccount: string;
  owner: string;
  domainName: string;
  leaseStart: bigint;
  leaseEnd: bigint;
}

export type SnapshotAccount<T> =
  | { status: "found"; address: string; state: T }
  | { status: "not-found"; address: string }
  | { status: "invalid"; address: string; error: string };

export interface NameLookupSnapshot {
  label: string;
  fullyQualifiedName: string;
  configAddress: string;
  domainAddress: string;
  leaseAddress: string;
  config: RegistrarConfigState;
  domain: SnapshotAccount<DomainState>;
  lease: SnapshotAccount<LeaseState>;
}

export interface ReadonlyChainAccount {
  meta?: {
    owner?: string | { toThruFmt(): string };
    dataSize?: number;
    flags?: {
      isDeleted?: boolean;
    };
  };
  data?: {
    data?: Uint8Array;
  };
}

export interface ReadonlyAccountReader {
  get(address: string, signal?: AbortSignal): Promise<ReadonlyChainAccount>;
}
