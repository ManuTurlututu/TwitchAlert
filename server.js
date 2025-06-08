require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const fs = require('fs').promises;
const path = require('path');

const app = express();

// Configuration
const clientId = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;
const redirectUri = 'https://twitch-followed-streams.glitch.me/auth/twitch/callback';
const scope = 'user:read:follows';
const NOTIFICATIONS_FILE = path.join(__dirname, 'notifications.json');
const NOTIFICATION_LOG_FILE = path.join(__dirname, 'NotificationLog.json');

// Vérification des variables d'environnement
if (!clientId || !clientSecret) {
    console.error('Erreur : TWITCH_CLIENT_ID ou TWITCH_CLIENT_SECRET manquant dans .env');
    process.exit(1);
}

// Middleware
app.use(express.static('public'));
app.use(cookieParser());
app.use(express.json());

// Stockage des paramètres de notification
let notificationSettings = [];

// Fonction pour charger les paramètres depuis le fichier
async function loadNotificationSettings() {
    try {
        const data = await fs.readFile(NOTIFICATIONS_FILE, 'utf8');
        return JSON.parse(data) || [];
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        console.error('Erreur lors de la lecture de notifications.json:', error);
        return [];
    }
}

// Fonction pour sauvegarder les paramètres dans le fichier
async function saveNotificationSettings(settings) {
    try {
        await fs.writeFile(NOTIFICATIONS_FILE, JSON.stringify(settings, null, 2));
        console.log('Paramètres de notification sauvegardés dans notifications.json');
    } catch (error) {
        console.error('Erreur lors de la sauvegarde de notifications.json:', error);
    }
}

// Fonction pour charger le journal des notifications
async function loadNotificationLog() {
    try {
        const data = await fs.readFile(NOTIFICATION_LOG_FILE, 'utf8');
        return JSON.parse(data) || [];
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.writeFile(NOTIFICATION_LOG_FILE, JSON.stringify([]));
            return [];
        }
        console.error('Erreur lors de la lecture de NotificationLog.json:', error);
        return [];
    }
}

// Fonction pour sauvegarder le journal des notifications
async function saveNotificationLog(log) {
    try {
        await fs.writeFile(NOTIFICATION_LOG_FILE, JSON.stringify(log, null, 2));
        console.log('Journal des notifications sauvegardé dans NotificationLog.json');
    } catch (error) {
        console.error('Erreur lors de la sauvegarde de NotificationLog.json:', error);
    }
}

// Charger les paramètres au démarrage
(async () => {
    notificationSettings = await loadNotificationSettings();
    console.log('Paramètres de notification chargés:', notificationSettings);
    // Initialiser NotificationLog.json si nécessaire
    await loadNotificationLog();
})();

// Fonction pour rafraîchir le jeton d'accès
async function refreshAccessToken(refreshToken) {
    try {
        const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
            params: {
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: refreshToken,
                grant_type: 'refresh_token'
            }
        });

        const { access_token, refresh_token, expires_in } = response.data;
        if (!access_token) {
            throw new Error('Aucun jeton d’accès reçu lors du rafraîchissement');
        }

        return {
            accessToken: access_token,
            refreshToken: refresh_token || refreshToken,
            expiresIn: expires_in
        };
    } catch (error) {
        console.error('Erreur lors du rafraîchissement du jeton :', error.message);
        throw error;
    }
}

// Endpoint pour initier l'authentification Twitch
app.get('/auth/twitch', (req, res) => {
    const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}`;
    console.log('Auth URL:', authUrl);
    res.redirect(authUrl);
});

// Endpoint pour gérer le callback OAuth
app.get('/auth/twitch/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) {
        return res.status(400).json({ error: 'Aucun code fourni' });
    }

    try {
        const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
            params: {
                client_id: clientId,
                client_secret: clientSecret,
                code: code,
                grant_type: 'authorization_code',
                redirect_uri: redirectUri
            }
        });

        const { access_token, refresh_token, expires_in } = response.data;
        if (!access_token || !refresh_token) {
            throw new Error('Aucun jeton d’accès ou refresh_token reçu');
        }

        res.cookie('twitch_access_token', access_token, {
            maxAge: 4 * 60 * 60 * 1000,
            httpOnly: true,
            secure: true,
            sameSite: 'strict'
        });

        res.cookie('twitch_refresh_token', refresh_token, {
            maxAge: 60 * 24 * 60 * 60 * 1000,
            httpOnly: true,
            secure: true,
            sameSite: 'strict'
        });

        res.redirect('/index.html');
    } catch (error) {
        console.error('Erreur lors de l’échange du jeton :', error.message);
        res.status(500).json({ error: 'Erreur lors de l’authentification' });
    }
});

// Endpoint pour rafraîchir le jeton côté client
app.get('/refresh-token', async (req, res) => {
    const refreshToken = req.cookies.twitch_refresh_token;
    if (!refreshToken) {
        return res.status(401).json({ error: 'Aucun refresh_token disponible' });
    }

    try {
        const { accessToken, refreshToken: newRefreshToken, expiresIn } = await refreshAccessToken(refreshToken);

        res.cookie('twitch_access_token', accessToken, {
            maxAge: 4 * 60 * 60 * 1000,
            httpOnly: true,
            secure: true,
            sameSite: 'strict'
        });

        res.cookie('twitch_refresh_token', newRefreshToken, {
            maxAge: 60 * 24 * 60 * 60 * 1000,
            httpOnly: true,
            secure: true,
            sameSite: 'strict'
        });

        res.json({ access_token: accessToken });
    } catch (error) {
        res.status(500).json({ error: 'Erreur lors du rafraîchissement du jeton' });
    }
});

// Endpoint pour récupérer le jeton depuis le cookie
app.get('/get-token', async (req, res) => {
    let accessToken = req.cookies.twitch_access_token;
    const refreshToken = req.cookies.twitch_refresh_token;

    if (!accessToken && refreshToken) {
        try {
            const { accessToken: newAccessToken, refreshToken: newRefreshToken } = await refreshAccessToken(refreshToken);

            res.cookie('twitch_access_token', newAccessToken, {
                maxAge: 4 * 60 * 60 * 1000,
                httpOnly: true,
                secure: true,
                sameSite: 'strict'
            });

            res.cookie('twitch_refresh_token', newRefreshToken, {
                maxAge: 60 * 24 * 60 * 60 * 1000,
                httpOnly: true,
                secure: true,
                sameSite: 'strict'
            });

            accessToken = newAccessToken;
        } catch (error) {
            console.error('Erreur lors du rafraîchissement dans /get-token :', error.message);
            return res.json({ access_token: null });
        }
    }

    res.json({ access_token: accessToken || null });
});

// Endpoint pour mettre à jour les paramètres de notification
app.post('/set-notification', async (req, res) => {
    const { userId, broadcasterId, notificationsEnabled } = req.body;

    console.log('Requête reçue pour /set-notification:', { userId, broadcasterId, notificationsEnabled });

    if (!userId || !broadcasterId || typeof notificationsEnabled !== 'boolean') {
        console.error('Paramètres invalides:', { userId, broadcasterId, notificationsEnabled });
        return res.status(400).json({ error: 'Paramètres manquants ou invalides' });
    }

    try {
        const existingSetting = notificationSettings.find(
            setting => setting.userId === userId && setting.broadcasterId === broadcasterId
        );

        if (existingSetting) {
            existingSetting.notificationsEnabled = notificationsEnabled;
        } else {
            notificationSettings.push({ userId, broadcasterId, notificationsEnabled });
        }

        await saveNotificationSettings(notificationSettings);

        console.log('Paramètres de notification mis à jour:', { userId, broadcasterId, notificationsEnabled });

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Erreur lors de la mise à jour des paramètres de notification:', error.message);
        res.status(500).json({ error: 'Erreur serveur lors de la mise à jour des notifications' });
    }
});

// Endpoint pour récupérer les paramètres de notification
app.get('/get-notifications', (req, res) => {
    const userId = req.query.userId;
    console.log('Requête reçue pour /get-notifications:', { userId });

    if (!userId) {
        console.error('userId manquant');
        return res.status(400).json({ error: 'userId manquant' });
    }

    try {
        const settings = notificationSettings
            .filter(setting => setting.userId === userId)
            .map(setting => ({
                broadcasterId: setting.broadcasterId,
                notificationsEnabled: setting.notificationsEnabled
            }));

        console.log('Paramètres de notification renvoyés:', settings);

        res.status(200).json(settings);
    } catch (error) {
        console.error('Erreur lors de la récupération des paramètres de notification:', error.message);
        res.status(500).json({ error: 'Erreur serveur lors de la récupération des notifications' });
    }
});

// Endpoint pour sauvegarder une notification dans le journal
app.post('/save-notification-log', async (req, res) => {
    const notification = req.body;
    if (
        !notification.id ||
        !notification.user_id ||
        !notification.user_name ||
        !notification.title ||
        !notification.avatar_url ||
        !notification.timestamp
    ) {
        console.error('Données de notification invalides:', notification);
        return res.status(400).json({ error: 'Données de notification invalides' });
    }

    try {
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        let notificationLog = await loadNotificationLog();
        notificationLog = notificationLog.filter(item => item.timestamp > sevenDaysAgo);
        notificationLog.unshift(notification);
        await saveNotificationLog(notificationLog);
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Erreur lors de l\'enregistrement de la notification:', error.message);
        res.status(500).json({ error: 'Erreur serveur lors de l\'enregistrement de la notification' });
    }
});

// Endpoint pour récupérer le journal des notifications
app.get('/get-notification-log', async (req, res) => {
    try {
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        let notificationLog = await loadNotificationLog();
        notificationLog = notificationLog.filter(item => item.timestamp > sevenDaysAgo);
        await saveNotificationLog(notificationLog);
        res.status(200).json(notificationLog);
    } catch (error) {
        console.error('Erreur lors de la récupération du journal des notifications:', error.message);
        res.status(500).json({ error: 'Erreur serveur lors de la récupération du journal des notifications' });
    }
});

// Route de secours pour la racine
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Gestion des erreurs globales
app.use((err, req, res, next) => {
    console.error('Erreur serveur:', err.stack);
    res.status(500).json({ error: 'Erreur serveur interne' });
});

// Démarrer le serveur
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Serveur en écoute sur le port ${port}`);
});