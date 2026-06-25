const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*", // Accetta connessioni da qualsiasi sito, incluso Netlify
        methods: ["GET", "POST"],
        transports: ["websocket"] // Forza l'uso dei websocket anche lato server
    }
});
const path = require('path');

app.use(express.static(__dirname));
let matchmakingLobbies = { coop: [], versus: [] };
let activeGames = {};
let playerToRoomMap = {}; 

const AVAILABLE_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange'];

function generateSecretCode() {
    let code = [];
    for(let i=0; i<4; i++) {
        code.push(AVAILABLE_COLORS[Math.floor(Math.random() * AVAILABLE_COLORS.length)]);
    }
    return code;
}

io.on('connection', (socket) => {

    socket.on('joinGame', (data) => {
        let mode = data.mode === 'versus' ? 'versus' : 'coop';
        let player = { id: socket.id, name: data.name || "Guest", score: 0, attemptsCount: 0 };
        
        matchmakingLobbies[mode].push(player);
        
        if (matchmakingLobbies[mode].length >= 2) {
            let p1 = matchmakingLobbies[mode].shift();
            let p2 = matchmakingLobbies[mode].shift();
            let roomId = `room_${p1.id}_${p2.id}`;
            
            p1.roomId = roomId;
            p2.roomId = roomId;

            playerToRoomMap[p1.id] = roomId;
            playerToRoomMap[p2.id] = roomId;

            activeGames[roomId] = {
                id: roomId,
                mode: mode,
                players: [p1, p2],
                // Versus ha codici separati per i due giocatori, Coop ha un codice unico condiviso
                secretCode: mode === 'versus' ? { [p1.id]: generateSecretCode(), [p2.id]: generateSecretCode() } : generateSecretCode(),
                turn: 0,
                round: mode === 'versus' ? { [p1.id]: 1, [p2.id]: 1 } : 1
            };

            io.sockets.sockets.get(p1.id)?.join(roomId);
            io.sockets.sockets.get(p2.id)?.join(roomId);

            io.to(roomId).emit('startGameSignal', {
                mode: mode,
                players: activeGames[roomId].players,
                turn: activeGames[roomId].turn,
                round: 1
            });
        }
    });

    socket.on('submitAttempt', (guess) => {
        let targetRoomId = playerToRoomMap[socket.id];

        if (!targetRoomId || !activeGames[targetRoomId]) return;
        let game = activeGames[targetRoomId];
        let playerIdx = game.players.findIndex(p => p.id === socket.id);
        if (playerIdx === -1) return;

        if (game.mode === 'coop' && game.turn !== playerIdx) return; 

        let secret = game.mode === 'versus' ? game.secretCode[socket.id] : game.secretCode;
        let result = Array(4).fill("");
        let codeCopy = [...secret];

        for(let i=0; i<4; i++) {
            if(guess[i] === secret[i]) { result[i] = "#2ecc71"; codeCopy[i] = null; }
        }
        for(let i=0; i<4; i++) {
            if(!result[i]) {
                let idx = codeCopy.indexOf(guess[i]);
                if(idx !== -1) { result[i] = "#f1c40f"; codeCopy[idx] = null; }
                else { result[i] = "#44445c"; }
            }
        }
        result.sort((a,b) => (a==="#2ecc71"?1:a==="#f1c40f"?2:3) - (b==="#2ecc71"?1:b==="#f1c40f"?2:3));

        let wonRound = result.every(c => c === "#2ecc71");
        game.players[playerIdx].attemptsCount++;

        if (wonRound) {
            game.players[playerIdx].score += Math.max(100, 1000 - (game.players[playerIdx].attemptsCount * 100));
            game.players[playerIdx].attemptsCount = 0;

            if (game.mode === 'versus') {
                game.round[socket.id]++;
                
                // Fine partita se superiamo il settimo round
                if (game.round[socket.id] > 7) {
                    let lAltro = game.players.find(p => p.id !== socket.id);
                    if (game.round[lAltro.id] > 7) {
                        let winnerName = "Pareggio";
                        if(game.players[0].score > game.players[1].score) winnerName = game.players[0].name;
                        else if(game.players[1].score > game.players[0].score) winnerName = game.players[1].name;
                        
                        io.to(targetRoomId).emit('roundResult', { matchWinner: winnerName, players: game.players, guess, result });
                        game.players.forEach(p => delete playerToRoomMap[p.id]);
                        delete activeGames[targetRoomId];
                        return;
                    } else {
                        socket.emit('roundResult', { roundFinished: true, nextRound: "In attesa dell'avversario...", players: game.players, guess, result });
                        return;
                    }
                }

                game.secretCode[socket.id] = generateSecretCode();
                socket.emit('roundResult', { roundFinished: true, nextRound: game.round[socket.id], players: game.players, guess, result });
                
                let lAltro = game.players.find(p => p.id !== socket.id);
                io.to(targetRoomId).emit('roundResult', { currentRound: game.round[lAltro.id], players: game.players });
                return;
            } else {
                // Logica COOP
                game.round++;
                game.secretCode = generateSecretCode();
                
                if (game.round > 7) {
                    io.to(targetRoomId).emit('roundResult', { matchWinner: `Vittoria di Squadra! Punteggio totale: ${game.players[0].score + game.players[1].score}`, players: game.players, guess, result });
                    game.players.forEach(p => delete playerToRoomMap[p.id]);
                    delete activeGames[targetRoomId];
                    return;
                } else {
                    game.turn = (game.turn + 1) % 2;
                    io.to(targetRoomId).emit('roundResult', { roundFinished: true, nextTurn: game.turn, nextRound: game.round, players: game.players, guess, result });
                    return;
                }
            }
        }

        // Se il tentativo non risolve il codice:
        if (game.mode === 'coop') {
            game.turn = (game.turn + 1) % 2;
            io.to(targetRoomId).emit('roundResult', {
                playerId: socket.id,
                guess: guess,
                result: result,
                nextTurn: game.turn,
                currentRound: game.round,
                players: game.players
            });
        } else {
            // Nel VERSUS inviamo solo al mittente per mantenere il segreto
            socket.emit('roundResult', {
                playerId: socket.id,
                guess: guess,
                result: result,
                currentRound: game.round[socket.id],
                players: game.players
            });
        }
    });

    function handleDisconnectOrLeave() {
        matchmakingLobbies.coop = matchmakingLobbies.coop.filter(p => p.id !== socket.id);
        matchmakingLobbies.versus = matchmakingLobbies.versus.filter(p => p.id !== socket.id);

        let roomToClean = playerToRoomMap[socket.id];

        if (roomToClean && activeGames[roomToClean]) {
            let game = activeGames[roomToClean];
            let rimasto = game.players.find(p => p.id !== socket.id);
            
            if (rimasto) {
                if (game.mode === 'coop') {
                    io.to(rimasto.id).emit('playerLeftNotification', { 
                        message: `🏳️ Il tuo compagno si è disconnesso. Ritorno alla lobby.` 
                    });
                } else {
                    io.to(rimasto.id).emit('roundResult', { 
                        matchWinner: `${rimasto.name} \n\n(Vittoria a tavolino! L'avversario ha abbandonato il campo di battaglia)` 
                    });
                }
            }
            
            game.players.forEach(p => delete playerToRoomMap[p.id]);
            delete activeGames[roomToClean];
        }
    }

    socket.on('playerLeaveGame', handleDisconnectOrLeave);
    socket.on('disconnect', handleDisconnectOrLeave);
});

// Porta dinamica per il cloud (obbligatoria per Render)
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server online sulla porta ${PORT}`);
});
