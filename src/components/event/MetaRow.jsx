const ITEMS = [
  { key: "date", label: "Date" },
  { key: "venue", label: "Venue" },
  { key: "teamSize", label: "Team size" },
  {
    key: "payment",
    label: "Payment",
    format: (value) => (value ? `₹${value}` : "—"),
  },
  { key: "status", label: "Status" },
];

/**
 * Event meta strip — DATE / VENUE / TEAM SIZE / PAYMENT / STATUS with a
 * hairline grid. With an odd cell count the tail cell spans both mobile
 * columns so the white/10 backing never shows as an empty half-block.
 */
export default function MetaRow({ event }) {
  const tail = ITEMS.length - 1;
  const oddTail = ITEMS.length % 2 === 1;
  return (
    <div className="grid grid-cols-2 gap-px border border-white/10 bg-white/10 md:grid-cols-5">
      {ITEMS.map((item, i) => (
        // 90% opaque over near-black: the old backdrop blur read as
        // nothing but re-blurred the page under the cells on every scroll
        // frame — worst case on phones, where this grid is 2 columns.
        <div
          key={item.key}
          className={`bg-void/90 px-5 py-6 md:px-8 md:py-7 ${
            oddTail && i === tail ? "col-span-2 md:col-span-1" : ""
          }`}
        >
          <p className="text-[9px] font-medium uppercase tracking-[0.4em] text-lavender/70">{item.label}</p>
          <p className="mt-2.5 text-sm tracking-[0.12em] text-crystal md:text-[15px]">
            {item.format ? item.format(event[item.key]) : event[item.key]}
          </p>
        </div>
      ))}
    </div>
  );
}
