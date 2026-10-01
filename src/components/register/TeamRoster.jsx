/**
 * The team a leader brings.
 *
 * A leader on a per_team event pays once for the whole squad, which only means
 * anything if the database knows who is in the squad. This collects that: the
 * team name, and up to (cap - 1) teammates with the same profile fields the
 * leader is asked for.
 *
 * WHY THE CAP IS ONE LESS THAN THE EVENT SAYS
 *
 * Because the event's cap counts PEOPLE and the leader is one of them. "Up to 3"
 * is a team of three, so a leader who has one teammate has entered two people
 * and may add one more. The counter says so in those terms — "2 of 3" — because
 * "you can add 2" beside a card reading "TEAM · MAX 3" is the exact arithmetic
 * participants get wrong, and getting it wrong in the other direction means
 * arriving a person short.
 *
 * The cap is a PROP, not a constant. It comes from the event, which the console
 * edits, and this component must never hold a number of its own — a wizard that
 * says 3 while the database says 4 tells a leader they are full when they are
 * not.
 *
 * TWO RULES, ENFORCED IN TWO PLACES, ON PURPOSE
 *
 *   1. HERE, so the Save button stays disabled until the shape is right and the
 *      message arrives in the leader's own language.
 *   2. IN THE DATABASE (registration_set_team_members and
 *      trg_registration_members_cap), which is the authority.
 *
 * The browser check is duplicated logic and anyone can post to the REST API
 * directly. Only the server-side refusal protects the invariant; the only thing
 * decided here is when to enable the button.
 */
import { useMemo } from "react";
import Select from "../ui/Select.jsx";
import { validateTeam } from "../../data/registrations.js";

const YEARS = ["1st", "2nd", "3rd", "4th"];

const fieldClass =
  "w-full border border-lavender/25 bg-white/[0.03] px-4 py-2.5 text-sm tracking-wide text-crystal placeholder:text-crystal/30 outline-none transition-colors focus:border-lavender/75";
const labelClass =
  "mb-1.5 block text-[9px] font-medium uppercase tracking-[0.28em] text-lavender/70";

/** A blank teammate. A function, not a constant — this object is edited. */
const blankMember = () => ({
  name: "",
  email: "",
  roll_number: "",
  college_name: "",
  year: "",
  department: "",
  phone_number: "",
});

export { blankMember };

export default function TeamRoster({
  cap,
  teamName,
  members,
  onChange,
  lookups = { colleges: [], departments: [] },
  error,
}) {
  /* `cap` is the event's max_team_members INCLUDING the leader, so the number of
     rows this form may hold is one less. Null means the event asks for no
     roster at all and the caller should not have rendered this — read as one so
     the form is empty and inert rather than throwing. */
  const capSize = Math.max(Number(cap ?? 1), 1);
  const room = capSize - 1;
  const rows = members ?? [];

  const setTeamName = (value) => onChange({ teamName: value, members: rows });
  const setMember = (index, key) => (value) =>
    onChange({
      teamName,
      members: rows.map((m, i) => (i === index ? { ...m, [key]: value } : m)),
    });
  const addMember = () => onChange({ teamName, members: [...rows, blankMember()] });
  const removeMember = (index) =>
    onChange({ teamName, members: rows.filter((_, i) => i !== index) });

  /* The same check the save button uses, run on every render so the button and
     the inline message can never disagree about whether the team is valid. */
  const problem = useMemo(() => validateTeam(teamName, rows), [teamName, rows]);

  return (
    <div className="flex flex-col gap-6" data-testid="team-roster">
      <div>
        <label className={labelClass} htmlFor="reg-team-name">
          Team name
        </label>
        <input
          id="reg-team-name"
          name="team_name"
          value={teamName}
          onChange={(e) => setTeamName(e.target.value)}
          className={fieldClass}
          placeholder="e.g. NULL POINTERS"
          maxLength={60}
        />
        <p className="mt-1.5 text-[11px] text-crystal/45">
          What your team is called on the roster and at the venue.
        </p>
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[10px] font-medium uppercase tracking-[0.3em] text-lavender/75">
          Your teammates
        </h3>
        {/* People, not rows. The leader is the +1, and "1 (you) + N" is the
            only phrasing that cannot be misread as "I may enter N more". */}
        <span
          className={`text-[11px] uppercase tracking-[0.2em] ${
            rows.length >= room ? "text-emerald-300/80" : "text-crystal/40"
          }`}
          data-testid="team-count"
        >
          {1 + rows.length} of {capSize} people
        </span>
      </div>

      {room === 0 ? (
        <p className="text-sm text-crystal/55">
          This event allows one person, so there is nobody to add — you are the
          team.
        </p>
      ) : null}


      <ol className="flex flex-col gap-5">
        {rows.map((member, index) => (
          <li
            key={index}
            className="border border-lavender/20 bg-white/[0.02] p-4"
            data-testid={`team-member-${index}`}
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-[0.3em] text-gold/80">
                Teammate {index + 1}
              </span>
              <button
                type="button"
                onClick={() => removeMember(index)}
                data-action={`remove-member-${index}`}
                className="border border-ember/50 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ember transition hover:bg-ember/15"
              >
                Remove
              </button>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className={labelClass} htmlFor={`tm-${index}-name`}>
                  Full name
                </label>
                <input
                  id={`tm-${index}-name`}
                  value={member.name}
                  onChange={(e) => setMember(index, "name")(e.target.value)}
                  className={fieldClass}
                  placeholder="e.g. Aarav Sharma"
                />
              </div>
              <div>
                <label className={labelClass} htmlFor={`tm-${index}-roll`}>
                  Roll number
                </label>
                <input
                  id={`tm-${index}-roll`}
                  value={member.roll_number}
                  onChange={(e) => setMember(index, "roll_number")(e.target.value)}
                  className={fieldClass}
                  placeholder="21B81A0501"
                />
              </div>
              <div>
                <label className={labelClass} htmlFor={`tm-${index}-email`}>
                  Gmail
                </label>
                <input
                  id={`tm-${index}-email`}
                  type="email"
                  value={member.email}
                  onChange={(e) => setMember(index, "email")(e.target.value)}
                  className={fieldClass}
                  placeholder="name@gmail.com"
                />
              </div>
              <div>
                <label className={labelClass} htmlFor={`tm-${index}-college`}>
                  College
                </label>
                {/* Same reasoning as the leader's own form, and the same escape
                    hatch: a college the list has not heard of is information,
                    not an error, so the typed box is always there. */}
                {lookups.colleges.length ? (
                  <Select
                    id={`tm-${index}-college`}
                    tone="site"
                    value={member.college_name}
                    onChange={(value) => setMember(index, "college_name")(value)}
                    options={lookups.colleges.map((c) => ({ value: c.name, label: c.name }))}
                    placeholder="Select college"
                    className={fieldClass}
                  />
                ) : null}
                <input
                  value={member.college_name}
                  onChange={(e) => setMember(index, "college_name")(e.target.value)}
                  className={`${fieldClass} mt-2`}
                  placeholder="Or type the college"
                  aria-label={`College for teammate ${index + 1}, typed`}
                />
              </div>


              <div>
                <label className={labelClass} htmlFor={`tm-${index}-year`}>
                  Year
                </label>
                <Select
                  id={`tm-${index}-year`}
                  tone="site"
                  value={member.year}
                  onChange={(value) => setMember(index, "year")(value)}
                  options={YEARS.map((y) => ({ value: y, label: y }))}
                  placeholder="Select year"
                  className={fieldClass}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor={`tm-${index}-dept`}>
                  Department
                </label>
                {lookups.departments.length ? (
                  <Select
                    id={`tm-${index}-dept`}
                    tone="site"
                    value={member.department}
                    onChange={(value) => setMember(index, "department")(value)}
                    options={lookups.departments.map((d) => ({ value: d.name, label: d.name }))}
                    placeholder="Select department"
                    className={fieldClass}
                  />
                ) : null}
                <input
                  value={member.department}
                  onChange={(e) => setMember(index, "department")(e.target.value)}
                  className={`${fieldClass} mt-2`}
                  placeholder="Or type the department"
                  aria-label={`Department for teammate ${index + 1}, typed`}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor={`tm-${index}-phone`}>
                  Phone <span className="normal-case tracking-normal">(optional)</span>
                </label>
                <input
                  id={`tm-${index}-phone`}
                  value={member.phone_number}
                  onChange={(e) => setMember(index, "phone_number")(e.target.value)}
                  className={fieldClass}
                  placeholder="9876543210"
                />
              </div>
            </div>
          </li>
        ))}
      </ol>

      {rows.length < room ? (
        <button
          type="button"
          onClick={addMember}
          data-action="add-member"
          className="self-start border border-lavender/50 px-5 py-2.5 text-[10px] font-medium uppercase tracking-[0.28em] text-crystal/80 transition-colors duration-300 hover:border-lavender hover:text-crystal"
        >
          Add teammate
        </button>
      ) : (
        /* A cap the leader has reached is stated, not hidden. A button that
           silently stops appearing reads as a broken page. */
        <p className="text-[11px] text-crystal/45">
          That is the whole team — this event allows {capSize} people including
          you.
        </p>
      )}

      {error ? (
        <p
          role="alert"
          data-testid="team-error"
          className="border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
        >
          {error}
        </p>
      ) : null}

      {/* The live problem, shown only once something has been typed. Before that
          it is a wall of red for a form nobody has filled in yet. */}
      {!error && problem && teamName.trim() !== "" ? (
        <p className="text-[11px] text-amber-200/80">{problem}</p>
      ) : null}
    </div>
  );
}
