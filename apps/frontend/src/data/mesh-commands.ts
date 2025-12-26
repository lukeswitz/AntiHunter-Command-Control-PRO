export type CommandGroup =
  | 'Configuration'
  | 'Scanning'
  | 'Detection'
  | 'Triangulation'
  | 'Status'
  | 'Security';

export type CommandParamType = 'text' | 'number' | 'select' | 'duration' | 'channels' | 'pipeList';

export interface CommandParameter {
  key: string;
  label: string;
  type: CommandParamType;
  helper?: string;
  placeholder?: string;
  required?: boolean;
  options?: Array<{ label: string; value: string }>;
  allowForever?: boolean;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}

export interface CommandDefinition {
  name: string;
  group: CommandGroup;
  description: string;
  defaultTarget?: string;
  parameters: CommandParameter[];
  allowForever?: boolean;
  examples?: Array<{ target: string; params: string[]; label?: string }>;
}

export const MESH_COMMANDS: CommandDefinition[] = [
  {
    name: 'STATUS',
    group: 'Status',
    description:
      'Reports system status (mode, scan state, hits, targets, unique MACs, temperature, uptime, GPS).',
    defaultTarget: '@ALL',
    parameters: [],
    examples: [
      { target: '@ALL', params: [], label: 'All nodes' },
      { target: '@NODE_22', params: [], label: 'Specific node' },
    ],
  },
  {
    name: 'CONFIG_CHANNELS',
    group: 'Configuration',
    description: 'Configure WiFi channels using CSV list or range (1..14).',
    defaultTarget: '@NODE_22',
    parameters: [
      {
        key: 'channels',
        label: 'Channels',
        type: 'channels',
        placeholder: '1,6,11 or 1..14',
        helper: 'Comma list/range (1..14).',
        required: true,
      },
    ],
    examples: [
      { target: '@NODE_22', params: ['1,6,11'] },
      { target: '@ALL', params: ['1..14'] },
    ],
  },
  {
    name: 'CONFIG_TARGETS',
    group: 'Configuration',
    description: 'Update target watchlist using pipe-delimited MACs.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'macs',
        label: 'Target MACs',
        type: 'pipeList',
        placeholder: 'AA:BB:CC:DD:EE:FF|11:22:33:44:55:66',
        helper: 'Pipe-separated MAC list.',
        required: true,
      },
    ],
    examples: [
      {
        target: '@NODE_22',
        params: ['AA:BB:CC:DD:EE:FF|11:22:33:44:55:66'],
      },
    ],
  },
  {
    name: 'CONFIG_RSSI',
    group: 'Configuration',
    description: 'Set detection RSSI threshold (negative dBm).',
    defaultTarget: '@NODE_22',
    parameters: [
      {
        key: 'threshold',
        label: 'RSSI Threshold (dBm)',
        type: 'number',
        placeholder: '-65',
        helper: 'Value between -128 and -10 dBm.',
        required: true,
        min: -128,
        max: -10,
        step: 1,
      },
    ],
    examples: [{ target: '@NODE_22', params: ['-65'] }],
  },
  {
    name: 'CONFIG_NODEID',
    group: 'Configuration',
    description: 'Assign a new short identifier to a node.',
    defaultTarget: '@NODE_22',
    parameters: [
      {
        key: 'nodeId',
        label: 'Node Identifier',
        type: 'text',
        placeholder: 'AH03',
        helper: 'Uppercase letters/numbers, 2-6 characters.',
        required: true,
      },
    ],
    examples: [{ target: '@NODE_22', params: ['AH03'] }],
  },
  {
    name: 'SCAN_START',
    group: 'Scanning',
    description: 'Start scanning. mode: 0=WiFi, 1=BLE, 2=Both.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        options: [
          { label: '0 - WiFi', value: '0' },
          { label: '1 - BLE', value: '1' },
          { label: '2 - Both', value: '2' },
        ],
        required: true,
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'duration',
        placeholder: '60',
        required: true,
        min: 1,
        max: 86400,
        suffix: 'sec',
      },
      {
        key: 'channels',
        label: 'Channels',
        type: 'channels',
        placeholder: '1,6,11 or 1..14',
        required: true,
      },
    ],
    allowForever: true,
    examples: [
      { target: '@ALL', params: ['0', '60', '1,6,11'] },
      { target: '@NODE_22', params: ['2', '300', '1..14', 'FOREVER'] },
    ],
  },
  {
    name: 'DEVICE_SCAN_START',
    group: 'Scanning',
    description: 'Start device scan for WiFi/BLE devices.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        options: [
          { label: '0 - WiFi', value: '0' },
          { label: '1 - BLE', value: '1' },
          { label: '2 - Both', value: '2' },
        ],
        required: true,
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'duration',
        placeholder: '300',
        required: true,
        min: 1,
        max: 86400,
        suffix: 'sec',
      },
    ],
    allowForever: true,
    examples: [
      { target: '@ALL', params: ['2', '300'] },
      { target: '@NODE_22', params: ['2', '300', 'FOREVER'] },
    ],
  },
  {
    name: 'STOP',
    group: 'Scanning',
    description: 'Stop all operations currently running.',
    defaultTarget: '@ALL',
    parameters: [],
    examples: [{ target: '@ALL', params: [] }],
  },
  {
    name: 'BASELINE_START',
    group: 'Detection',
    description: 'Begin baseline recording for environment detection.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'duration',
        placeholder: '300',
        required: true,
        min: 1,
        max: 86400,
        suffix: 'sec',
      },
    ],
    allowForever: true,
    examples: [
      { target: '@ALL', params: ['300'] },
      { target: '@NODE_22', params: ['600', 'FOREVER'] },
    ],
  },
  {
    name: 'BASELINE_STATUS',
    group: 'Detection',
    description: 'Report baseline status across nodes.',
    defaultTarget: '@ALL',
    parameters: [],
  },
  {
    name: 'DRONE_START',
    group: 'Detection',
    description: 'Begin drone RID detection (WiFi only).',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'duration',
        placeholder: '600',
        required: true,
        min: 1,
        max: 86400,
        suffix: 'sec',
      },
    ],
    allowForever: true,
    examples: [
      { target: '@ALL', params: ['600'] },
      { target: '@NODE_22', params: ['600', 'FOREVER'] },
    ],
  },
  {
    name: 'DEAUTH_START',
    group: 'Detection',
    description: 'Start deauthentication detection.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'duration',
        placeholder: '300',
        required: true,
        min: 1,
        max: 86400,
        suffix: 'sec',
      },
    ],
    allowForever: true,
    examples: [
      { target: '@ALL', params: ['300'] },
      { target: '@NODE_22', params: ['300', 'FOREVER'] },
    ],
  },
  {
    name: 'RANDOMIZATION_START',
    group: 'Detection',
    description: 'Start MAC randomization detection (mode 0=WiFi,1=BLE,2=Both).',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        options: [
          { label: '0 - WiFi', value: '0' },
          { label: '1 - BLE', value: '1' },
          { label: '2 - Both', value: '2' },
        ],
        required: true,
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'duration',
        placeholder: '600',
        required: true,
        min: 1,
        max: 86400,
        suffix: 'sec',
      },
    ],
    allowForever: true,
    examples: [
      { target: '@ALL', params: ['2', '600'] },
      { target: '@NODE_22', params: ['0', '600', 'FOREVER'] },
    ],
  },
  {
    name: 'TRIANGULATE_START',
    group: 'Triangulation',
    description: 'Initiate triangulation for MAC or identity (T-xxx).',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'target',
        label: 'Target MAC/Identity',
        type: 'text',
        placeholder: 'AA:BB:CC:DD:EE:FF or T-sensor001',
        required: true,
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'duration',
        placeholder: '30',
        required: true,
        min: 20,
        max: 300,
        suffix: 'sec',
      },
    ],
    examples: [
      { target: '@ALL', params: ['AA:BB:CC:DD:EE:FF', '30'] },
      { target: '@NODE_22', params: ['T-sensor001', '600'] },
    ],
  },
  {
    name: 'TRIANGULATE_STOP',
    group: 'Triangulation',
    description: 'Stop active triangulation.',
    defaultTarget: '@ALL',
    parameters: [],
  },
  {
    name: 'TRIANGULATE_RESULTS',
    group: 'Triangulation',
    description: 'Fetch the latest triangulation results from a node.',
    defaultTarget: '@NODE_22',
    parameters: [],
  },
  {
    name: 'VIBRATION_STATUS',
    group: 'Status',
    description: 'Query tamper/vibration sensor status.',
    defaultTarget: '@NODE_22',
    parameters: [],
  },
  {
    name: 'ERASE_REQUEST',
    group: 'Security',
    description: 'Request erase token to perform a force erase',
    defaultTarget: '@NODE_22',
    parameters: [],
    examples: [
      { target: '@NODE_22', params: [], label: 'Request token' },
      { target: '@ALL', params: [], label: 'Broadcast request' },
    ],
  },
  {
    name: 'ERASE_FORCE',
    group: 'Security',
    description: 'Force emergency erase (requires admin token).',
    defaultTarget: '@NODE_22',
    parameters: [
      {
        key: 'token',
        label: 'Authorization Token',
        type: 'text',
        placeholder: 'AH_12345678_87654321_00001234',
        helper: 'Format AH_########_########_########',
        required: true,
      },
    ],
  },
  {
    name: 'ERASE_CANCEL',
    group: 'Security',
    description: 'Cancel an ongoing erase operation.',
    defaultTarget: '@ALL',
    parameters: [],
  },
  {
    name: 'AUTOERASE_ENABLE',
    group: 'Security',
    description: 'Enable auto-erase with optional custom parameters',
    defaultTarget: '@NODE_22',
    parameters: [
      {
        key: 'setupDelay',
        label: 'Setup Delay (seconds)',
        type: 'number',
        placeholder: '120',
        helper: 'Grace period before auto-erase activates (30-600s).',
        required: false,
        min: 30,
        max: 600,
        step: 1,
      },
      {
        key: 'eraseDelay',
        label: 'Erase Delay (seconds)',
        type: 'number',
        placeholder: '30',
        helper: 'Countdown before data destruction (10-300s).',
        required: false,
        min: 10,
        max: 300,
        step: 1,
      },
      {
        key: 'vibrationsRequired',
        label: 'Vibrations Required',
        type: 'number',
        placeholder: '3',
        helper: 'Number of vibrations to trigger (2-5).',
        required: false,
        min: 2,
        max: 5,
        step: 1,
      },
      {
        key: 'detectionWindow',
        label: 'Detection Window (seconds)',
        type: 'number',
        placeholder: '20',
        helper: 'Time window for vibration detection (10-60s).',
        required: false,
        min: 10,
        max: 60,
        step: 1,
      },
      {
        key: 'autoEraseCooldown',
        label: 'Auto-Erase Cooldown (seconds)',
        type: 'number',
        placeholder: '300',
        helper: 'Cooldown between tamper attempts (300-3600s).',
        required: false,
        min: 300,
        max: 3600,
        step: 1,
      },
    ],
    examples: [
      {
        target: '@NODE_22',
        params: [],
        label: 'Use defaults (120s setup, 30s erase, 3 vibs, 20s window, 300s cooldown)',
      },
      { target: '@NODE_22', params: ['60', '30', '3', '20', '300'], label: 'Custom parameters' },
    ],
  },
  {
    name: 'AUTOERASE_DISABLE',
    group: 'Security',
    description: 'Disable auto-erase functionality.',
    defaultTarget: '@NODE_22',
    parameters: [],
    examples: [
      { target: '@NODE_22', params: [], label: 'Disable auto-erase' },
      { target: '@ALL', params: [], label: 'Disable all nodes' },
    ],
  },
  {
    name: 'AUTOERASE_STATUS',
    group: 'Security',
    description: 'Check current auto-erase configuration and state.',
    defaultTarget: '@NODE_22',
    parameters: [],
    examples: [
      { target: '@NODE_22', params: [], label: 'Check node status' },
      { target: '@ALL', params: [], label: 'Check all nodes' },
    ],
  },
];

export const COMMAND_GROUP_ORDER: CommandGroup[] = [
  'Configuration',
  'Scanning',
  'Detection',
  'Triangulation',
  'Status',
  'Security',
];
