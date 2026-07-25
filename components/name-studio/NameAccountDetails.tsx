import type {
  NameLookupSnapshot,
  SnapshotAccount,
  DomainState,
} from "@/lib/thru/name-service/account-types";
import {
  NAME_DOMAIN_INVALID_MESSAGE,
  NAME_NOT_FOUND_MESSAGE,
  NAME_SNAPSHOT_WARNING,
  nameExplorerAddressUrl,
} from "@/lib/thru/name-service/constants";
import NameRecords from "./NameRecords";

interface NameAccountDetailsProps {
  snapshot: NameLookupSnapshot;
}

export function ExplorerAddressLink({
  address,
  label,
}: {
  address: string;
  label: string;
}) {
  return (
    <a
      className="name-address-link mono"
      href={nameExplorerAddressUrl(address)}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${label} in Thru Explorer`}
    >
      {address}
      <span aria-hidden="true">↗</span>
    </a>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function DomainResult({
  domain,
}: {
  domain: SnapshotAccount<DomainState>;
}) {
  if (domain.status === "not-found") {
    return (
      <div className="name-snapshot-empty" role="status">
        <strong>{NAME_NOT_FOUND_MESSAGE}</strong>
        <span>{NAME_SNAPSHOT_WARNING}</span>
      </div>
    );
  }
  if (domain.status === "invalid") {
    return (
      <p className="token-error" role="alert">
        {NAME_DOMAIN_INVALID_MESSAGE}
      </p>
    );
  }

  return (
    <>
      <dl className="name-detail-grid">
        <Detail label="Parent">
          <ExplorerAddressLink
            address={domain.state.parent}
            label="domain parent"
          />
        </Detail>
        <Detail label="Owner">
          <ExplorerAddressLink
            address={domain.state.owner}
            label="domain owner"
          />
        </Detail>
        <Detail label="Stored name">
          <span className="mono">{domain.state.name}</span>
        </Detail>
        <Detail label="Registration time (raw)">
          <span className="mono">
            {domain.state.registrationTime.toString()}
          </span>
        </Detail>
        <Detail label="Record count">
          <span className="mono">{domain.state.recordCount}</span>
        </Detail>
      </dl>
      <NameRecords records={domain.state.records} />
    </>
  );
}

export default function NameAccountDetails({
  snapshot,
}: NameAccountDetailsProps) {
  return (
    <>
      <section className="name-result-section" aria-labelledby="config-title">
        <div className="name-section-heading">
          <div>
            <p className="eyebrow token-eyebrow">Registrar config</p>
            <h3 id="config-title">Official AlphaNet registry</h3>
          </div>
          <ExplorerAddressLink
            address={snapshot.configAddress}
            label="Registrar config"
          />
        </div>

        <dl className="name-detail-grid">
          <Detail label="Name Service program">
            <ExplorerAddressLink
              address={snapshot.config.nameServiceProgramId}
              label="Name Service program"
            />
          </Detail>
          <Detail label="Root registrar">
            <ExplorerAddressLink
              address={snapshot.config.rootRegistrar}
              label="root registrar"
            />
          </Detail>
          <Detail label="Payment mint">
            <ExplorerAddressLink
              address={snapshot.config.paymentMint}
              label="payment mint"
            />
          </Detail>
          <Detail label="Treasurer token account">
            <ExplorerAddressLink
              address={snapshot.config.treasurerTokenAccount}
              label="treasurer token account"
            />
          </Detail>
          <Detail label="Price per year (raw)">
            <span className="mono">
              {snapshot.config.pricePerYear.toString()}
            </span>
          </Detail>
        </dl>
      </section>

      <section className="name-result-section" aria-labelledby="domain-title">
        <div className="name-section-heading">
          <div>
            <p className="eyebrow token-eyebrow">Domain account</p>
            <h3 id="domain-title">{snapshot.fullyQualifiedName}</h3>
          </div>
          <ExplorerAddressLink
            address={snapshot.domainAddress}
            label="derived domain account"
          />
        </div>
        <DomainResult domain={snapshot.domain} />
      </section>
    </>
  );
}

