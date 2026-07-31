/**
 * Icon set for the "Вибори" module — inline SVG so the page ships no icon font
 * and every glyph inherits `currentColor`.
 */

const iconPaths = {
  building: (
    <>
      <path d="M4 21V6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v15" />
      <path d="M12 21V10h7a1 1 0 0 1 1 1v10" />
      <path d="M7 9h2M7 13h2M7 17h2M15 14h2M15 18h2" />
      <path d="M2 21h20" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  contacts: (
    <>
      <rect height="18" rx="3" width="16" x="4" y="3" />
      <path d="M2 8h3M2 12h3M2 16h3" />
      <circle cx="12" cy="10" r="2.4" />
      <path d="M8.5 17a3.8 3.8 0 0 1 7 0" />
    </>
  ),
  door: (
    <>
      <path d="M5 21V4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v17" />
      <path d="M3 21h18" />
      <circle cx="13" cy="12" fill="currentColor" r="0.9" stroke="none" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M4 19h16" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
      <path d="m14.5 6 3 3" />
    </>
  ),
  home: (
    <>
      <path d="m3 10.5 9-7 9 7V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V10.5Z" />
      <path d="M9.5 21v-6h5v6" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2" />
    </>
  ),
  list: (
    <>
      <path d="M9 6h12M9 12h12M9 18h12" />
      <circle cx="4.5" cy="6" fill="currentColor" r="0.9" stroke="none" />
      <circle cx="4.5" cy="12" fill="currentColor" r="0.9" stroke="none" />
      <circle cx="4.5" cy="18" fill="currentColor" r="0.9" stroke="none" />
    </>
  ),
  mail: (
    <>
      <rect height="14" rx="3" width="18" x="3" y="5" />
      <path d="m4 7.5 8 5.5 8-5.5" />
    </>
  ),
  map: (
    <>
      <path d="m9 4.5 6 3 5.1-2.6a.6.6 0 0 1 .9.6v11.9l-6 3-6-3-5.1 2.6a.6.6 0 0 1-.9-.6V7.5l6-3Z" />
      <path d="M9 4.5v12M15 7.5v12" />
    </>
  ),
  message: (
    <>
      <path d="M21 12a8 8 0 0 1-8 8H8l-4 3v-5.5A8 8 0 0 1 13 4a8 8 0 0 1 8 8Z" />
      <path d="M9 11h8M9 15h5" />
    </>
  ),
  note: (
    <>
      <path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  phone: (
    <path d="M7 3.5h2.2l1.4 3.6-1.8 1.5a11 11 0 0 0 5.1 5.1l1.5-1.8 3.6 1.4V15c0 2.2-1.6 3.6-3.8 3.4C9.6 17.8 5.4 13.6 4.6 7.3 4.4 5.1 5.8 3.5 7 3.5Z" />
  ),
  pin: (
    <>
      <path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z" />
      <circle cx="12" cy="10" r="2.6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: (
    <>
      <path d="M20 11a8 8 0 1 0-2.6 6.4" />
      <path d="M20 4v7h-7" />
    </>
  ),
  satellite: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.3 9h17.4M3.3 15h17.4" />
      <path d="M12 3a13.5 13.5 0 0 1 0 18 13.5 13.5 0 0 1 0-18Z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m16 16 5 5" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V4.8A.8.8 0 0 1 9.8 4h4.4a.8.8 0 0 1 .8.8V7" />
      <path d="M6.5 7l.8 12.2a1 1 0 0 0 1 .8h7.4a1 1 0 0 0 1-.8L17.5 7" />
      <path d="M10.5 11v6M13.5 11v6" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.6" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 5.2a3.6 3.6 0 0 1 0 5.6M18 20a6.4 6.4 0 0 0-2-4.6" />
    </>
  ),
  warning: (
    <>
      <path d="M10.3 4.2 2.5 18a2 2 0 0 0 1.8 3h15.4a2 2 0 0 0 1.8-3L13.7 4.2a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  zoomIn: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M11 8v6M8 11h6M16 16l5 5" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M8 11h6M16 16l5 5" />
    </>
  ),
};

function ElectionsIcon({ name, size = 20, className }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
      width={size}
    >
      {iconPaths[name] ?? iconPaths.info}
    </svg>
  );
}

export default ElectionsIcon;
