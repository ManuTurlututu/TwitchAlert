const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const app = express();

app.use(express.json());
app.use(cookieParser());

const db = new sqlite3.Database(':memory:'); // Remplacer par un fichier persistant si nécessaire

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS notifications (
        userId TEXT,
        broadcasterId TEXT,
        notificationsEnabled BOOLEAN,
        PRIMARY KEY (userId, broadcasterId)
    )`);
});

const clientId = 'fwff5k4xwotxh84zfgo3hla684twde';
const clientSecret = process.env.TWITCH_CLIENT_SECRET;
const redirectUri = process.env.TWITCH_REDIRECT_URI || 'https://your-glitch-project.glitch.me/auth/twitch/callback';

app.get('/auth/twitch', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('auth_state', state, { httpOnly: true });
    const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=user:read:follows&state=${state}`;
    res.redirect(authUrl);
});

app.get('/auth/twitch/callback', async (req, res) => {
    const { code, state } = req.query;
    const storedState = req.cookies.auth_state;

    if (!state || state !== storedState) {
        return res.status(400).send('État invalide');
    }

    try {
        const tokenResponse = await axios.post('https://id.twitch.tv/oauth2/token', null, {
            params: {
                client_id: clientId,
                client_secret: clientSecret,
                code,
                grant_type: 'authorization_code',
                redirect_uri: redirectUri
            }
        });

        const { access_token, refresh_token, expires_in } = tokenResponse.data;
        res.cookie('access_token', access_token, { httpOnly: true, maxAge: expires_in * 1000 });
        res.cookie('refresh_token', refresh_token, { httpOnly: true });
        res.redirect('/');
    } catch (error) {
        console.error('Erreur lors de l\'échange du code :', error);
        res.status(500).send('Erreur lors de l\'authentification');
    }
});

app.get('/get-token', (req, res) => {
    const accessToken = req.cookies.access_token;
    if (!accessToken) {
        return res.status(401).json({ error: 'Non authentifié' });
    }
    res.json({ access_token: accessToken });
});

app.post('/refresh-token', async (req, res) => {
    const refreshToken = req.cookies.refresh_token;
    if (!refreshToken) {
        return res.status(401).json({ error: 'Aucun jeton de rafraîchissement' });
    }

    try {
        const tokenResponse = await axios.post('https://id.twitch.tv/oauth2/token', null, {
            params: {
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: refreshToken,
                grant_type: 'refresh_token'
            }
        });

        const { access_token, refresh_token, expires_in } = tokenResponse.data;
        res.cookie('access_token', access_token, { httpOnly: true, maxAge: expires_in * 1000 });
        res.cookie('refresh_token', refresh_token, { httpOnly: true });
        res.json({ access_token });
    } catch (error) {
        console.error('Erreur lors du rafraîchissement du jeton :', error);
        res.status(500).json({ error: 'Échec du rafraîchissement du jeton' });
    }
});

app.get('/get-notifications', (req, res) => {
    const { userId } = req.query;
    if (!userId) {
        return res.status(400).json({ error: 'userId requis' });
    }

    db.all('SELECT broadcasterId, notificationsEnabled FROM notifications WHERE userId = ?', [userId], (err, rows) => {
        if (err) {
            console.error('Erreur lors de la récupération des notifications :', err);
            return res.status(500).json({ error: 'Erreur serveur' });
        }
        res.json(rows);
    });
});

app.post('/set-notification', (req, res) => {
    const { userId, broadcasterId, notificationsEnabled } = req.body;
    if (!userId || !broadcasterId || typeof notificationsEnabled !== 'boolean') {
        return res.status(400).json({ error: 'Paramètres invalides' });
    }

    db.run(
        'INSERT OR REPLACE INTO notifications (userId, broadcasterId, notificationsEnabled) VALUES (?, ?, ?)',
        [userId, broadcasterId, notificationsEnabled],
        (err) => {
            if (err) {
                console.error('Erreur lors de la mise à jour des notifications :', err);
                return res.status(500).json({ error: 'Erreur serveur' });
            }
            res.json({ success: true });
        }
    );
});

app.listen(3000, () => {
    console.log('Serveur démarré sur le port 3000');
});