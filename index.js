const express = require("express");

const QRCode = require("qrcode");

const qrcode = require("qrcode-terminal");

const makeWASocket = require("@whiskeysockets/baileys").default;

const {
    DisconnectReason,
    useMultiFileAuthState,
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");

const path = require("path");

const fs = require("fs");


// ============================================================
// CONFIGURATION
// ============================================================

const app = express();

const PORT = process.env.WHATSAPP_PORT || 3001;

const SESSION_ROOT = path.join(
    __dirname,
    "whatsapp-session"
);

const CONTACTS_FILE = path.join(
    SESSION_ROOT,
    "contacts.json"
);

const INDEX_FILE = path.join(
    __dirname,
    "index.html"
);


// ============================================================
// MIDDLEWARE
// ============================================================

app.use(express.json());


// ============================================================
// ÉTAT GLOBAL
// ============================================================

let sock = null;

let whatsappConnected = false;

let currentQR = null;

let qrText = null;

let contacts = [];

let contactsLoading = false;

let reconnecting = false;

let starting = false;


// ============================================================
// LOGS DE DÉMARRAGE
// ============================================================

console.log("");

console.log("🚀 SHIFTLOW - TEST BAILEYS");

console.log("────────────────────────────────────");

console.log(
    `📁 Session : ${SESSION_ROOT}`
);

console.log(
    `📁 Session existe : ${fs.existsSync(SESSION_ROOT)}`
);

console.log(
    `📁 Contacts : ${CONTACTS_FILE}`
);

console.log(
    `🌐 Port : ${PORT}`
);

console.log("────────────────────────────────────");


// ============================================================
// CRÉATION DU DOSSIER SESSION
// ============================================================

if (!fs.existsSync(SESSION_ROOT)) {

    fs.mkdirSync(
        SESSION_ROOT,
        {
            recursive: true,
        }
    );

}


// ============================================================
// CHARGER LES CONTACTS DEPUIS contacts.json
// ============================================================

function loadContactsFromFile() {

    try {

        if (!fs.existsSync(CONTACTS_FILE)) {

            console.log(
                "📂 Aucun contacts.json trouvé."
            );

            contacts = [];

            return;

        }


        const raw =
            fs.readFileSync(
                CONTACTS_FILE,
                "utf8"
            );


        if (!raw.trim()) {

            contacts = [];

            return;

        }


        const parsed =
            JSON.parse(raw);


        if (!Array.isArray(parsed)) {

            console.log(
                "⚠️ contacts.json invalide."
            );

            contacts = [];

            return;

        }


        contacts = parsed;


        console.log(
            `📂 ${contacts.length} contacts chargés depuis contacts.json`
        );


    } catch (error) {

        console.error(
            "❌ Impossible de charger contacts.json :",
            error
        );

        contacts = [];

    }

}


// ============================================================
// SAUVEGARDER LES CONTACTS
// ============================================================

function saveContactsToFile() {

    try {

        fs.writeFileSync(
            CONTACTS_FILE,
            JSON.stringify(
                contacts,
                null,
                2
            ),
            "utf8"
        );


        console.log(
            `💾 ${contacts.length} contacts sauvegardés.`
        );


    } catch (error) {

        console.error(
            "❌ Erreur sauvegarde contacts :",
            error
        );

    }

}


// ============================================================
// NETTOYER UN NUMÉRO
// ============================================================

function cleanNumber(value) {

    if (!value) {

        return "";

    }


    return String(value)
        .replace("@s.whatsapp.net", "")
        .replace("@c.us", "")
        .replace("@lid", "")
        .replace(/\D/g, "");

}


// ============================================================
// VÉRIFIER SI C'EST UN CONTACT INDIVIDUEL
// ============================================================

function isIndividualJid(jid) {

    if (!jid) {

        return false;

    }


    const value =
        String(jid);


    if (
        value.endsWith("@g.us")
    ) {

        return false;

    }


    if (
        value.endsWith("@broadcast")
    ) {

        return false;

    }


    if (
        value === "status@broadcast"
    ) {

        return false;

    }


    return (
        value.endsWith("@s.whatsapp.net") ||
        value.endsWith("@c.us") ||
        value.endsWith("@lid")
    );

}


// ============================================================
// NORMALISER UN CONTACT
// ============================================================

function normalizeContact(contact) {

    if (!contact) {

        return null;

    }


    const jid =
        contact.id ||
        contact.jid ||
        contact.key?.remoteJid ||
        "";


    if (!jid) {

        return null;

    }


    if (!isIndividualJid(jid)) {

        return null;

    }


    const name =
        contact.name ||
        contact.notify ||
        contact.pushName ||
        contact.verifiedName ||
        contact.vname ||
        contact.shortName ||
        "";


    const number =
        cleanNumber(
            contact.number ||
            contact.phoneNumber ||
            contact.phone ||
            contact.id?.user ||
            jid.split("@")[0]
        );


    if (!number) {

        return null;

    }


    if (!name || !String(name).trim()) {

        return null;

    }


    return {

        id: String(jid),

        name: String(name).trim(),

        number,

        isMyContact:
            contact.isMyContact !== false,

    };

}


// ============================================================
// AJOUTER / METTRE À JOUR UN CONTACT
// ============================================================

function addOrUpdateContact(contact) {

    const normalized =
        normalizeContact(contact);


    if (!normalized) {

        return false;

    }


    const existingIndex =
        contacts.findIndex(
            (item) =>
                item.id === normalized.id ||
                (
                    item.number &&
                    item.number === normalized.number
                )
        );


    if (existingIndex === -1) {

        contacts.push(
            normalized
        );

        return true;

    }


    const previous =
        contacts[existingIndex];


    contacts[existingIndex] = {

        ...previous,

        ...normalized,

        name:
            normalized.name ||
            previous.name,

        number:
            normalized.number ||
            previous.number,

    };


    return true;

}


// ============================================================
// TRAITER UNE LISTE DE CONTACTS
// ============================================================

function processContacts(list) {

    if (!Array.isArray(list)) {

        return 0;

    }


    let added =
        0;


    for (
        const contact of list
    ) {

        if (
            addOrUpdateContact(contact)
        ) {

            added++;

        }

    }


    if (added > 0) {

        contacts.sort(
            (a, b) =>
                a.name.localeCompare(
                    b.name,
                    "fr",
                    {
                        sensitivity: "base",
                    }
                )
        );


        saveContactsToFile();

    }


    return added;

}


// ============================================================
// QR CODE
// ============================================================

async function setQRCode(qr) {

    qrText = qr;


    try {

        currentQR =
            await QRCode.toDataURL(
                qr
            );


    } catch (error) {

        console.error(
            "❌ Erreur génération QR :",
            error
        );

        currentQR = null;

    }


    console.log("");

    console.log(
        "📱 SCANNE CE QR CODE AVEC WHATSAPP"
    );

    console.log(
        "────────────────────────────────────"
    );


    try {

        qrcode.generate(
            qr,
            {
                small: true,
            }
        );


    } catch (error) {

        console.error(
            "❌ Impossible d'afficher le QR dans le terminal :",
            error
        );

    }


    console.log(
        "────────────────────────────────────"
    );

}


// ============================================================
// RÉCUPÉRATION DES CONTACTS DU STORE BAILEYS
// ============================================================

function extractContactsFromStore() {

    if (!sock) {

        return [];

    }


    const store =
        sock.store;


    if (!store) {

        return [];

    }


    if (
        store.contacts &&
        typeof store.contacts === "object"
    ) {

        return Object.values(
            store.contacts
        );

    }


    return [];

}


// ============================================================
// RÉCUPÉRATION DES CONTACTS DEPUIS LES DONNÉES BAILEYS
// ============================================================

function updateContactsFromBaileys() {

    const storeContacts =
        extractContactsFromStore();


    if (
        storeContacts.length > 0
    ) {

        const added =
            processContacts(
                storeContacts
            );


        console.log(
            `📱 Contacts du store : ${storeContacts.length} → ${contacts.length} disponibles`
        );


        return added;

    }


    return 0;

}


// ============================================================
// INITIALISATION WHATSAPP
// ============================================================

async function startWhatsApp() {

    if (starting) {

        console.log(
            "ℹ️ Initialisation déjà en cours."
        );

        return;

    }


    starting = true;


    try {

        console.log(
            "🔄 Initialisation Baileys..."
        );


        const {
            state,
            saveCreds,
        } =
            await useMultiFileAuthState(
                SESSION_ROOT
            );


        sock =
            makeWASocket({

                auth: state,

                printQRInTerminal: false,

                browser: [
                    "ShiftFlow",
                    "Chrome",
                    "1.0.0",
                ],

                markOnlineOnConnect: false,

                syncFullHistory: false,

            });


        console.log(
            "✅ Socket Baileys créé."
        );


        // ====================================================
        // SAUVEGARDE AUTH
        // ====================================================

        sock.ev.on(
            "creds.update",
            saveCreds
        );


        // ====================================================
        // CONNEXION
        // ====================================================

        sock.ev.on(
            "connection.update",
            async (update) => {

                const {
                    connection,
                    lastDisconnect,
                    qr,
                } = update;


                // --------------------------------------------
                // NOUVEAU QR
                // --------------------------------------------

                if (qr) {

                    whatsappConnected = false;

                    currentQR = null;

                    await setQRCode(
                        qr
                    );

                }


                // --------------------------------------------
                // OUVERTURE
                // --------------------------------------------

                if (
                    connection === "open"
                ) {

                    whatsappConnected = true;

                    currentQR = null;

                    qrText = null;

                    reconnecting = false;


                    console.log("");

                    console.log(
                        "────────────────────────────────────"
                    );

                    console.log(
                        "✅ WHATSAPP CONNECTÉ"
                    );

                    console.log(
                        "────────────────────────────────────"
                    );


                    console.log(
                        `📱 Contacts actuellement en mémoire : ${contacts.length}`
                    );


                    // Essaye immédiatement
                    // de récupérer ceux présents
                    // dans le store.

                    updateContactsFromBaileys();

                }


                // --------------------------------------------
                // FERMETURE
                // --------------------------------------------

                if (
                    connection === "close"
                ) {

                    whatsappConnected = false;

                    currentQR = null;

                    qrText = null;


                    const statusCode =
                        new Boom(
                            lastDisconnect?.error
                        )?.output?.statusCode;


                    const shouldReconnect =
                        statusCode !==
                        DisconnectReason.loggedOut;


                    console.log("");

                    console.log(
                        "❌ CONNEXION WHATSAPP FERMÉE"
                    );


                    console.log(
                        `📋 Code : ${statusCode}`
                    );


                    if (
                        statusCode ===
                        DisconnectReason.loggedOut
                    ) {

                        console.log(
                            "🚪 Session WhatsApp déconnectée manuellement."
                        );

                        console.log(
                            "ℹ️ Supprime le dossier whatsapp-session pour refaire un QR."
                        );

                        return;

                    }


                    if (
                        shouldReconnect &&
                        !reconnecting
                    ) {

                        reconnecting = true;


                        console.log(
                            "🔄 Reconnexion automatique dans 2 secondes..."
                        );


                        setTimeout(
                            () => {

                                starting = false;

                                startWhatsApp()
                                    .catch(
                                        (error) => {

                                            console.error(
                                                "❌ Erreur reconnexion :",
                                                error
                                            );

                                            reconnecting = false;

                                        }
                                    );

                            },
                            2000
                        );

                    }

                }

            }
        );


        // ====================================================
        // CONTACTS
        // ====================================================

        sock.ev.on(
            "contacts.upsert",
            (newContacts) => {

                console.log(
                    `📱 contacts.upsert : ${newContacts.length} reçus`
                );


                const added =
                    processContacts(
                        newContacts
                    );


                console.log(
                    `📱 Contacts disponibles : ${contacts.length}`
                );


                if (added > 0) {

                    console.log(
                        `➕ ${added} nouveau(x) contact(s)`
                    );

                }

            }
        );


        // ====================================================
        // MISE À JOUR CONTACTS
        // ====================================================

        sock.ev.on(
            "contacts.update",
            (updates) => {

                console.log(
                    `📱 contacts.update : ${updates.length} reçus`
                );


                for (
                    const update of updates
                ) {

                    const jid =
                        update.id ||
                        update.jid ||
                        "";


                    if (!jid) {

                        continue;

                    }


                    const existingIndex =
                        contacts.findIndex(
                            (contact) =>
                                contact.id === jid
                        );


                    if (
                        existingIndex !== -1
                    ) {

                        const existing =
                            contacts[
                                existingIndex
                            ];


                        const updated = {

                            ...existing,

                            name:
                                update.notify ||
                                update.name ||
                                update.pushName ||
                                existing.name,

                        };


                        contacts[
                            existingIndex
                        ] = updated;


                        continue;

                    }


                    addOrUpdateContact({

                        id: jid,

                        name:
                            update.notify ||
                            update.name ||
                            update.pushName ||
                            "",

                        number:
                            cleanNumber(
                                jid.split("@")[0]
                            ),

                    });

                }


                contacts.sort(
                    (a, b) =>
                        a.name.localeCompare(
                            b.name,
                            "fr",
                            {
                                sensitivity: "base",
                            }
                        )
                );


                saveContactsToFile();


                console.log(
                    `📱 Contacts disponibles : ${contacts.length}`
                );

            }
        );


        // ====================================================
        // CHARGEMENT CONTACTS À PARTIR DU STORE
        // ====================================================

        setTimeout(
            () => {

                if (
                    whatsappConnected
                ) {

                    updateContactsFromBaileys();

                }

            },
            3000
        );


        // ====================================================
        // CHARGEMENT CONTACTS APRÈS SYNCHRONISATION
        // ====================================================

        setTimeout(
            () => {

                if (
                    whatsappConnected
                ) {

                    const found =
                        updateContactsFromBaileys();


                    console.log(
                        `🔎 Vérification contacts après synchronisation : ${found} ajout(s)`
                    );

                }

            },
            10000
        );


    } catch (error) {

        console.error(
            "❌ Erreur initialisation Baileys :",
            error
        );


        whatsappConnected = false;

        currentQR = null;

        qrText = null;


    } finally {

        starting = false;

    }

}


// ============================================================
// ROUTE STATUS
// ============================================================

app.get(
    "/status",
    (req, res) => {

        res.json({

            connected:
                whatsappConnected,

            hasQR:
                !!currentQR,

            qr:
                currentQR,

            contactCount:
                contacts.length,

            contactsLoading:
                contactsLoading,

            contactsLoaded:
                contacts.length > 0,

        });

    }
);


// ============================================================
// ROUTE QR
// ============================================================

app.get(
    "/whatsapp/qr",
    (req, res) => {

        if (!currentQR) {

            return res.status(404).json({

                error:
                    "Aucun QR code disponible.",

            });

        }


        res.json({

            qr:
                currentQR,

        });

    }
);


// ============================================================
// ROUTE CONTACTS
// ============================================================

app.get(
    "/contacts",
    (req, res) => {

        if (!whatsappConnected) {

            return res.status(400).json({

                error:
                    "WhatsApp n'est pas connecté.",

            });

        }


        res.json(
            contacts
        );

    }
);


// ============================================================
// ROUTE REFRESH
// ============================================================

app.post(
    "/refresh",
    async (req, res) => {

        if (!whatsappConnected) {

            return res.status(400).json({

                error:
                    "WhatsApp n'est pas connecté.",

            });

        }


        if (contactsLoading) {

            return res.status(409).json({

                error:
                    "Récupération des contacts déjà en cours.",

            });

        }


        contactsLoading = true;


        try {

            console.log("");

            console.log(
                "🔄 Actualisation manuelle des contacts..."
            );


            const before =
                contacts.length;


            const added =
                updateContactsFromBaileys();


            const after =
                contacts.length;


            console.log(
                `📱 Refresh terminé : ${after} contacts`
            );


            res.json({

                success:
                    true,

                count:
                    contacts.length,

                added,

                previousCount:
                    before,

            });


        } catch (error) {

            console.error(
                "❌ Erreur refresh contacts :",
                error
            );


            res.status(500).json({

                success:
                    false,

                error:
                    "Erreur pendant la récupération des contacts.",

            });


        } finally {

            contactsLoading = false;

        }

    }
);


// ============================================================
// ROUTE RACINE
// ============================================================

app.get(
    "/",
    (req, res) => {

        if (
            fs.existsSync(INDEX_FILE)
        ) {

            return res.sendFile(
                INDEX_FILE
            );

        }


        res.send(`
            <!DOCTYPE html>
            <html lang="fr">
            <head>
                <meta charset="UTF-8">
                <title>ShiftFlow WhatsApp</title>
            </head>
            <body>
                <h1>ShiftFlow - WhatsApp</h1>
                <p>index.html introuvable.</p>
            </body>
            </html>
        `);

    }
);


// ============================================================
// SERVEUR
// ============================================================

app.listen(
    PORT,
    () => {

        console.log("");

        console.log(
            `🌐 Serveur lancé sur le port ${PORT}`
        );

        console.log(
            `👉 http://localhost:${PORT}`
        );

        console.log("");

    }
);


// ============================================================
// ARRÊT PROPRE
// ============================================================

let shuttingDown = false;


async function shutdown(signal) {

    if (shuttingDown) {

        return;

    }


    shuttingDown = true;


    console.log("");

    console.log(
        `🛑 Arrêt du service (${signal})...`
    );


    try {

        if (
            sock &&
            typeof sock.end === "function"
        ) {

            sock.end(
                undefined
            );

        }

    } catch (error) {

        console.error(
            "⚠️ Erreur fermeture socket :",
            error
        );

    }


    process.exit(0);

}


process.on(
    "SIGINT",
    () => shutdown("SIGINT")
);


process.on(
    "SIGTERM",
    () => shutdown("SIGTERM")
);


// ============================================================
// DÉMARRAGE
// ============================================================

loadContactsFromFile();

startWhatsApp()
    .catch(
        (error) => {

            console.error(
                "❌ Erreur fatale :",
                error
            );

        }
    );