// Bun bundles CSS imported from the client
declare module '*.css';
// SVG files imported `with { type: 'text' }` are their markup
declare module '*.svg' {
  const markup: string;
  export default markup;
}
