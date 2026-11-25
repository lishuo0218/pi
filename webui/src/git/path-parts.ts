// Path split shared by the changed-file list and the commit file list: the
// directory stays dimmed while the tail, the part the user scans for, is bright.
export function pathParts(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? { dir: "", name: path } : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}