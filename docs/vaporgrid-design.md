# VaporGrid interface contract

The approved Programs and Remove AV photo mockups guide the 1.6 styling slice.
They illustrate the visual direction; they are not runtime verification.

- Charcoal background `#171719`, panels `#202023`, raised controls `#29292D`,
  foreground `#F1F1F3`, muted text `#B7B7C1`, crimson edges `#D61F45` and
  focus `#FF4D73`. Primary controls keep text on surfaces rather than crimson.
- Compartments use 8px gutters and 12px padding. The subtle grid stays behind
  panels; the restrained glow belongs to selection edges, never text.
- The left rail is permanently icon-only, with 44px buttons, hidden accessible
  names, native shortcut tooltips, pressed state and vertical scrolling.
- Programs retain virtualized row geometry. Remove AV retains its stacked
  warnings, locally scrolling table, detail panel and real confirmation dialog.
- Preserve all actions, menus, source failures, recovery/review blocking and
  cancellation. Do not add the illustrative inspector or docked queue.
- Preserve light/high-contrast themes, text scale and reduced motion. Narrow
  layouts wrap controls and scroll content without hiding navigation.

Browser qualification requires the actual App with inert API fixtures at
520×620, 760×620 and 1280×800, all three themes, 200% text scale, keyboard/focus,
menus and Remove AV states. Automated screenshots do not certify accessibility
or native Tauri/vendor-removal behavior.
