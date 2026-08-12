export interface AudioFileRef {
  path: string;
  container: string;
}

export function canonicalContainer(container: string): string {
  return container.trim().toLowerCase().replace(/^\.+/, '');
}
