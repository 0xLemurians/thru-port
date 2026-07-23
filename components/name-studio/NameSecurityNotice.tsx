import { NAME_SECURITY_MESSAGES } from "@/lib/thru/name-service/constants";

export default function NameSecurityNotice() {
  return (
    <aside className="name-security-notice" aria-labelledby="name-safety-title">
      <strong id="name-safety-title">Name safety</strong>
      <ul>
        {NAME_SECURITY_MESSAGES.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    </aside>
  );
}

