export function assertServiceNotRetired(servicesDirectory: string): void;
export function installServiceRetirement(servicesDirectory: string, marker: {
  schema: 'eros-market-native-retirement/1'; planSetHash: string; engine: string;
  recipient: string; senders: string[];
}): void;
