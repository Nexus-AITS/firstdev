import { useEffect, useRef, useState } from "react";
import CinematicButton from "../ui/CinematicButton.jsx";
import { YEAR_OPTIONS, createRegistration } from "../../data/registrations.js";

/** Field chrome copied from the Admin console controls so both forms match. */
const INPUT_CLASS =
  "w-full border border-white/15 bg-white/[0.03] px-4 py-3 text-xs tracking-wide text-crystal placeholder:text-crystal/35 focus:border-lavender/60 focus:outline-none";
const SELECT_CLASS = `${INPUT_CLASS} cursor-pointer appearance-none`;

const FIELDS = [
  { name: "name", label: "Full name", placeholder: "As printed on your ID card", autoComplete: "name" },
  { name: "roll_number", label: "Roll number", placeholder: "e.g. 21B81A0501" },
  { name: "college_name", label: "College name", placeholder: "e.g. AITS Tirupati", wide: true },
  { name: "department", label: "Department", placeholder: "e.g. CSE" },
];

function FieldError({ id, message }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-2 text-[10px] uppercase tracking-[0.24em] text-gold/90">
      {message}
    </p>
  );
}

/**
 * The gateway registration form — name, roll number, college, department, year.
 *
 * Validation lives in src/data/registrations.js next to the SQL CHECK
 * constraints it mirrors, so this component only renders what that module
 * reports; the record it writes is the same one the /admin console reads.
 */
export default function RegistrationForm({ contextLabel = "", defaultName = "", onSubmitted }) {
  const [values, setValues] = useState({
    name: defaultName,
    roll_number: "",
    college_name: "",
    department: "",
    year: "",
  });
  const [errors, setErrors] = useState({});
  const firstField = useRef(null);

  // The form replaces the button that opened it, so focus moves in with it —
  // otherwise keyboard users have to hunt for where the page went.
  useEffect(() => {
    firstField.current?.focus({ preventScroll: true });
  }, []);

  const update = (field) => (event) => {
    const { value } = event.target;
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  };

  const submit = (event) => {
    event.preventDefault();
    const result = createRegistration(values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    onSubmitted?.(result.row);
  };

  const describedBy = (field) => (errors[field] ? `reg-${field}-error` : undefined);

  return (
    <form
      onSubmit={submit}
      noValidate
      className="mx-auto mt-9 w-full max-w-xl border border-white/12 bg-white/[0.02] p-6 text-left md:p-8"
    >
      <p className="text-[10px] font-medium uppercase tracking-[0.42em] text-lavender/75">
        Registration details
      </p>
      {contextLabel ? (
        <h2 className="mt-3 font-display text-2xl tracking-[0.1em] text-crystal">{contextLabel}</h2>
      ) : null}
      <p className="mt-2 text-xs leading-relaxed text-crystal/50">
        Five details and the gateway opens. This is the same record the NEXUS console reviews.
      </p>

      <div className="mt-6 grid gap-5 sm:grid-cols-2">
        {FIELDS.map((field, index) => (
          <div key={field.name} className={field.wide ? "sm:col-span-2" : ""}>
            <label
              htmlFor={`reg-${field.name}`}
              className="block text-[10px] font-medium uppercase tracking-[0.32em] text-crystal/60"
            >
              {field.label}
            </label>
            <input
              id={`reg-${field.name}`}
              name={field.name}
              type="text"
              ref={index === 0 ? firstField : undefined}
              value={values[field.name]}
              onChange={update(field.name)}
              placeholder={field.placeholder}
              autoComplete={field.autoComplete ?? "off"}
              aria-invalid={errors[field.name] ? true : undefined}
              aria-describedby={describedBy(field.name)}
              className={`${INPUT_CLASS} mt-2`}
            />
            <FieldError id={`reg-${field.name}-error`} message={errors[field.name]} />
          </div>
        ))}

        <div>
          <label
            htmlFor="reg-year"
            className="block text-[10px] font-medium uppercase tracking-[0.32em] text-crystal/60"
          >
            Year of study
          </label>
          <select
            id="reg-year"
            name="year"
            value={values.year}
            onChange={update("year")}
            aria-invalid={errors.year ? true : undefined}
            aria-describedby={describedBy("year")}
            className={`${SELECT_CLASS} mt-2`}
          >
            <option value="" disabled className="bg-void text-crystal">
              Select year
            </option>
            {YEAR_OPTIONS.map((year) => (
              <option key={year} value={year} className="bg-void text-crystal">
                {year} year
              </option>
            ))}
          </select>
          <FieldError id="reg-year-error" message={errors.year} />
        </div>
      </div>

      <div className="mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-between">
        <CinematicButton type="submit" className="px-8">
          Submit registration
        </CinematicButton>
        <p className="text-[10px] uppercase tracking-[0.3em] text-crystal/35">
          Reviewed before the hand-off
        </p>
      </div>
    </form>
  );
}
