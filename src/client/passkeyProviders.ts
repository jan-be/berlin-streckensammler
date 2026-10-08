/**
 * Who keeps a passkey, by the AAGUID its authenticator reports when it is
 * made: the common password managers and platform authenticators. Anything
 * else is just "Passkey".
 */
const PROVIDERS: Record<string, string> = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
  'fdb141b2-5d84-443e-8a35-4698c205a502': 'KeePassXC',
  'b84e4048-15dc-4dd0-8640-f4f60813c8af': 'NordPass',
  '0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6': 'Keeper',
};

export const providerName = (aaguid: string | null) => (aaguid && PROVIDERS[aaguid.toLowerCase()]) || null;
