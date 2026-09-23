const ITEMS = [
  { key: "date", label: "Date" },
  { key: "venue", label: "Venue" },
  { key: "teamSize", label: "Team size" },
  { key: "status", label: "Status" },
];

/** Event meta strip — DATE / VENUE / TEAM SIZE / STATUS with hairline grid. */
export default function MetaRow({ event }) {
  return (
    <div className="grid grid-cols-2 gap-px border border-white/10 bg-white/10 md:grid-cols-4">
      {ITEMS.map((item) => (
        <div key={item.key} className="bg-void/90 px-5 py-6 backdrop-blur-sm md:px-8 md:py-7">
          <p className="text-[9px] font-medium uppercase tracking-[0.4em] text-lavender/70">{item.label}</p>
          <p className="mt-2.5 text-sm tracking-[0.12em] text-crystal md:text-[15px]">{event[item.key]}</p>
        </div>
      ))}
    </div>
  );
}
