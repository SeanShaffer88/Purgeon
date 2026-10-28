// Byte sizes in plain words, shared by every view. Kept in its own tiny
// module so the views that use it can load lazily without pulling each
// other into the first-paint bundle.
export const formatBytes = (b) => {
  if (!b) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
};
