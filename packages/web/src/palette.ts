// Presentation colours preserve server identity and join order.
const mineral: Record<string, string> = {
  '#5EEAD4': '#A5B99A', '#F59E0B': '#D1AA74', '#A78BFA': '#98AEBD',
  '#F472B6': '#C79688', '#60A5FA': '#B0A7C0', '#A3E635': '#C2BE8C',
};
export const displayColor = (color: string) => mineral[color.toUpperCase()] ?? color;
