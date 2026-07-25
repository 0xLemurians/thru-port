import type { NameLookupSnapshot } from "@/lib/thru/name-service/account-types";
import {
  LEASE_TIMESTAMP_WARNING,
  NAME_LEASE_INVALID_MESSAGE,
  NAME_NOT_FOUND_MESSAGE,
  NAME_SNAPSHOT_WARNING,
} from "@/lib/thru/name-service/constants";
import { ExplorerAddressLink } from "./NameAccountDetails";

interface LeaseDetailsProps {
  snapshot: NameLookupSnapshot;
}

export default function LeaseDetails({ snapshot }: LeaseDetailsProps) {
  const lease = snapshot.lease;

  return (
    <section className="name-result-section" aria-labelledby="lease-title">
      <div className="name-section-heading">
        <div>
          <p className="eyebrow token-eyebrow">Registrar lease</p>
          <h3 id="lease-title">Lease account</h3>
        </div>
        <ExplorerAddressLink
          address={snapshot.leaseAddress}
          label="derived lease account"
        />
      </div>

      {lease.status === "not-found" && (
        <div className="name-snapshot-empty" role="status">
          <strong>{NAME_NOT_FOUND_MESSAGE}</strong>
          <span>{NAME_SNAPSHOT_WARNING}</span>
        </div>
      )}

      {lease.status === "invalid" && (
        <p className="token-error" role="alert">
          {NAME_LEASE_INVALID_MESSAGE}
        </p>
      )}

      {lease.status === "found" && (
        <>
          <dl className="name-detail-grid">
            <div>
              <dt>Domain account</dt>
              <dd>
                <ExplorerAddressLink
                  address={lease.state.domainAccount}
                  label="lease domain account"
                />
              </dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd>
                <ExplorerAddressLink
                  address={lease.state.owner}
                  label="lease owner"
                />
              </dd>
            </div>
            <div>
              <dt>Stored domain name</dt>
              <dd className="mono">{lease.state.domainName}</dd>
            </div>
            <div>
              <dt>Lease start (raw)</dt>
              <dd className="mono">{lease.state.leaseStart.toString()}</dd>
            </div>
            <div>
              <dt>Lease end (raw)</dt>
              <dd className="mono">{lease.state.leaseEnd.toString()}</dd>
            </div>
          </dl>
          <p className="name-timestamp-warning" role="note">
            {LEASE_TIMESTAMP_WARNING} No active, expired, or claimable status
            is inferred.
          </p>
        </>
      )}
    </section>
  );
}

