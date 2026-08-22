// Un único lenguaje de ilustración para HUD y weapon wheel. Las siluetas
// siguen las proporciones de los modelos procedurales de rig.js; no son logos
// ni copias de armas externas. currentColor = masa, naranja = lectura clave.
const ICONS = Object.freeze({
  smg: `
    <path class="wi-body" d="M9 25h18l11-9h57l10 7h31l8 5h38v11h-42l-12 8H91l-8 15H65l5-17H42l-11-7H9z"/>
    <path class="wi-mid" d="M43 19h58v8H43zm67 7h31v12h-31zM31 25L14 15H6l9 16z"/>
    <path class="wi-dark" d="M70 44h20l-4 19H66zm-22-2h13L48 61H32zm77-4h16v9h-16z"/>
    <path class="wi-accent" d="M45 28h45v4H45zm71-1h20v4h-20zM73 57h15v5H73z"/>
    <path class="wi-line" d="M102 18v-6h31m-8 11v-7m-18 23H76m80-11h28"/>
  `,
  shotgun: `
    <path class="wi-body" d="M5 29h31l18-13h48l12 8h82v10h-83l-13 10H61L47 62H28l13-21H5z"/>
    <path class="wi-mid" d="M53 18h58v18H53zM14 29L3 20h17l24 10-7 8z"/>
    <path class="wi-dark" d="M66 42h18l9 20H75zM30 39h18L34 62H18zm86-5h39v10h-39z"/>
    <path class="wi-accent" d="M117 26h39v7h-39zm43 0h31v4h-31zM59 20h6v14h-6z"/>
    <path class="wi-line" d="M108 21h84m-77 17h76m-58-12v12m12-12v12m12-12v12"/>
  `,
  pistol: `
    <path class="wi-body" d="M38 17h112l12 7v16H96l-9 22H65l7-22H47l-9-7z"/>
    <path class="wi-mid" d="M44 18h106v10H44zm34 22h19l-5 22H67z"/>
    <path class="wi-dark" d="M72 39h28l-5 10H79l-4 13H62zm40-10h16v10h-16z"/>
    <path class="wi-accent" d="M48 29h51v5H48zm25 28h20v5H73z"/>
    <path class="wi-line" d="M51 23h94m-8-5v9m-26 4v9m-4-4H91"/>
  `,
  grenade: `
    <path class="wi-body" d="M75 16h48l9 10v28l-9 9H75l-9-9V26z"/>
    <path class="wi-mid" d="M74 22h50v8H74zm0 29h50v7H74zM83 7h21v11H83z"/>
    <path class="wi-dark" d="M81 31h36v19H81z"/>
    <path class="wi-accent" d="M68 38h62v7H68z"/>
    <path class="wi-line" d="M104 8h23l10 10m-23 1l18-5m-57 18h48M75 49h48"/>
    <circle class="wi-line" cx="139" cy="17" r="8"/>
  `,
  sniper: `
    <path class="wi-body" d="M2 28h31l17-10h49l10 8h82v9h-74l-17 11H67L56 62H39l9-19H32l-10-7H2z"/>
    <path class="wi-mid" d="M49 20h61v18H49zM14 28L3 20h17l24 10-8 8zM111 26h49v10h-49z"/>
    <path class="wi-dark" d="M72 44h20l-5 18H66zm37-26h12v8h-12z"/>
    <path class="wi-accent" d="M53 22h7v14h-7zm73 5h48v5h-48z"/>
    <path class="wi-line" d="M91 15h45m-37 0v11m28-11v11m36 12l26-1m-75 0h73"/>
    <ellipse class="wi-line" cx="91" cy="13" rx="12" ry="7"/>
    <ellipse class="wi-line" cx="137" cy="13" rx="9" ry="6"/>
  `,
  bazooka: `
    <path class="wi-body" d="M10 23h154l10 6v13l-10 6H10L2 41V29z"/>
    <path class="wi-mid" d="M2 19h26v33H2zm157-5h31v43h-31zM77 16h38v12H77z"/>
    <path class="wi-dark" d="M72 47h21l-5 16H68zm48 0h17l9 15h-20zM84 9h24v9H84z"/>
    <path class="wi-accent" d="M29 24h10v23H29zm57-10h17v5H86zm46 11h10v22h-10z"/>
    <path class="wi-line" d="M42 27h90M42 44h90m-73-21v25m54-25v25"/>
  `,
});

export const weaponIconMarkup = (weapon, extraClass = '') => {
  const key = Object.prototype.hasOwnProperty.call(ICONS, weapon) ? weapon : 'smg';
  return `<svg class="weapon-glyph icon-${key} ${extraClass}" data-icon="${key}" viewBox="0 0 200 64" aria-hidden="true" focusable="false">${ICONS[key]}</svg>`;
};
