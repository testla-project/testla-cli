export type SnapshotElement = {
  ref: string;
  role: string;
  name: string;
  locatorCode: string;
};

export function selectorFromSnapshot(el: SnapshotElement): string {
  return el.locatorCode;
}

export function constName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}