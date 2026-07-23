const STEPS = ["Account", "Fund", "Code"] as const;

export default function Stepper({ current }: { current: number }) {
  return (
    <ol className="stepper" aria-label="Onboarding progress">
      {STEPS.map((label, i) => {
        const index = i + 1;
        const state =
          index < current ? "done" : index === current ? "active" : "upcoming";
        return (
          <li
            key={label}
            className={`step step-${state}`}
            aria-current={state === "active" ? "step" : undefined}
          >
            <span className="step-node">{state === "done" ? "✓" : index}</span>
            <span className="step-label">{label}</span>
            {index < STEPS.length && (
              <span className="step-line" aria-hidden="true" />
            )}
          </li>
        );
      })}
    </ol>
  );
}
