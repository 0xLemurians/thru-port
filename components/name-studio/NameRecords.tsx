import type { NameRecord } from "@/lib/thru/name-service/account-types";

interface NameRecordsProps {
  records: NameRecord[];
}

export default function NameRecords({ records }: NameRecordsProps) {
  return (
    <section className="name-records" aria-labelledby="name-records-title">
      <div className="name-section-heading">
        <h4 id="name-records-title">Records</h4>
        <span className="unit">{records.length} total</span>
      </div>

      {records.length === 0 ? (
        <p className="hint">No records are stored in this domain account.</p>
      ) : (
        <dl className="name-record-list">
          {records.map((record, index) => (
            <div
              className="name-record"
              key={`${record.key}-${index}`}
            >
              <dt>
                <code>{record.key}</code>
                <span>{record.keyByteLength}/32 bytes</span>
              </dt>
              <dd>
                <span>{record.value || "(empty value)"}</span>
                <small>{record.valueByteLength}/256 bytes</small>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

