// ==================================================================================================================
// Composants partagés (header + sidebar)
// Modifie-les ici une seule fois : toutes les pages se mettent à jour automatiquement.
// ==================================================================================================================

// Les liens de la sidebar. Ajoute une page = ajoute une ligne ici.
const NAV_LINKS = [
    { label: "Dashboard", href: "./index.html" },
    { label: "IPs", href: "./ips.html" },
];

// ------------------------------------------------------------------------------------------------------------------
// <app-header>
// ------------------------------------------------------------------------------------------------------------------
class AppHeader extends HTMLElement {
    connectedCallback() {
        this.innerHTML = `
            <header>
                <a href="./index.html" class="logo">
                    <img src="./content/logo.png" alt="Logo">
                    <h1>NetMap</h1>
                </a>
            </header>
        `;
    }
}
customElements.define("app-header", AppHeader);

// ------------------------------------------------------------------------------------------------------------------
// <app-sidebar>
// ------------------------------------------------------------------------------------------------------------------
class AppSidebar extends HTMLElement {
    connectedCallback() {
        // Nom du fichier de la page courante (ex: "ips.html"), pour marquer le lien actif.
        const current = location.pathname.split("/").pop() || "index.html";

        const links = NAV_LINKS.map(({ label, href }) => {
            const file = href.split("/").pop();
            const active = file === current ? " class=\"active\"" : "";
            return `<a href="${href}"${active}>${label}</a>`;
        }).join("\n            ");

        this.innerHTML = `
            <aside>
            ${links}
            </aside>
        `;
    }
}
customElements.define("app-sidebar", AppSidebar);
