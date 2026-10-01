export function splitBotTime(value: string): readonly [string, string] {
  const parts = /^(\d{2}):(\d{2})$/.exec(value);
  return parts && Number(parts[1]) < 24 && Number(parts[2]) < 60 ? [parts[1]!, parts[2]!] : ['00', '00'];
}
export function updateBotTime(value: string, part: 'hour' | 'minute', next: string): string {
  const [hour, minute] = splitBotTime(value);
  if (!/^\d{2}$/.test(next) || Number(next) >= (part === 'hour' ? 24 : 60)) return value;
  return part === 'hour' ? `${next}:${minute}` : `${hour}:${next}`;
}
