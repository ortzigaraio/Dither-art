// Palettes for the "Paleta" colour mode and for the pixel modes of later phases (PLAN.md 5.4).
// Values are hex strings; parsing lives in color.js.

export const PALETTES = {
  horain: {
    name: { es: 'Horain', en: 'Horain' },
    colors: ['#15181E', '#66696F', '#C4F169', '#EDFAD1', '#F7F8FA'],
  },
  mac1bit: {
    name: { es: '1-bit Mac', en: '1-bit Mac' },
    colors: ['#000000', '#FFFFFF'],
  },
  gameboy: {
    name: { es: 'Game Boy DMG', en: 'Game Boy DMG' },
    colors: ['#0F380F', '#306230', '#8BAC0F', '#9BBC0F'],
  },
  cga: {
    name: { es: 'CGA', en: 'CGA' },
    colors: ['#000000', '#55FFFF', '#FF55FF', '#FFFFFF'],
  },
  ega16: {
    name: { es: 'EGA 16', en: 'EGA 16' },
    colors: [
      '#000000', '#0000AA', '#00AA00', '#00AAAA', '#AA0000', '#AA00AA', '#AA5500', '#AAAAAA',
      '#555555', '#5555FF', '#55FF55', '#55FFFF', '#FF5555', '#FF55FF', '#FFFF55', '#FFFFFF',
    ],
  },
  c64: {
    name: { es: 'C64', en: 'C64' },
    colors: [
      '#000000', '#FFFFFF', '#68372B', '#70A4B2', '#6F3D86', '#588D43', '#352879', '#B8C76F',
      '#6F4F25', '#433900', '#9A6759', '#444444', '#6C6C6C', '#9AD284', '#6C5EB5', '#959595',
    ],
  },
  pico8: {
    name: { es: 'PICO-8', en: 'PICO-8' },
    colors: [
      '#000000', '#1D2B53', '#7E2553', '#008751', '#AB5236', '#5F574F', '#C2C3C7', '#FFF1E8',
      '#FF004D', '#FFA300', '#FFEC27', '#00E436', '#29ADFF', '#83769C', '#FF77A8', '#FFCCAA',
    ],
  },
  endesga32: {
    name: { es: 'Endesga 32', en: 'Endesga 32' },
    colors: [
      '#BE4A2F', '#D77643', '#EAD4AA', '#E4A672', '#B86F50', '#733E39', '#3E2731', '#A22633',
      '#E43B44', '#F77622', '#FEAE34', '#FEE761', '#63C74D', '#3E8948', '#265C42', '#193C3E',
      '#124E89', '#0099DB', '#2CE8F5', '#FFFFFF', '#C0CBDC', '#8B9BB4', '#5A6988', '#3A4466',
      '#262B44', '#181425', '#FF0044', '#68386C', '#B55088', '#F6757A', '#E8B796', '#C28569',
    ],
  },
  sweetie16: {
    name: { es: 'Sweetie 16', en: 'Sweetie 16' },
    colors: [
      '#1A1C2C', '#5D275D', '#B13E53', '#EF7D57', '#FFCD75', '#A7F070', '#38B764', '#257179',
      '#29366F', '#3B5DC9', '#41A6F6', '#73EFF7', '#F4F4F4', '#94B0C2', '#566C86', '#333C57',
    ],
  },
  amber: {
    name: { es: 'Amber CRT', en: 'Amber CRT' },
    colors: ['#000000', '#3D2800', '#7A5000', '#B87800', '#FFB000'],
  },
  green: {
    name: { es: 'Green CRT', en: 'Green CRT' },
    colors: ['#000000', '#0A3D14', '#146B24', '#28B040', '#39FF6A'],
  },
  ironbow: {
    name: { es: 'Ironbow', en: 'Ironbow' },
    colors: ['#000000', '#1F0C5C', '#5A1A8C', '#A12D7A', '#DB4A3B', '#F58A1F', '#FCC93C', '#FFFFFF'],
  },
  custom: {
    name: { es: 'Personalizada', en: 'Custom' },
    colors: ['#000000', '#FFFFFF'],
  },
};

export const PALETTE_IDS = Object.keys(PALETTES);
