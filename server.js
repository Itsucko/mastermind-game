const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let matchmakingLobbies = { coop: [], versus: [] };
let activeGames = {};
let playerToRoomMap = {}; // Tracciamento certo e istantaneo del giocatore

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

            // Salva nella mappa globale dei record prima del via
            playerToRoomMap[p1.id] = roomId;
            playerToRoomMap[p2.id] = roomId;

            activeGames[roomId] = {
                id: roomId,
                mode: mode,
                players: [p1, p2],
                secretCode: generateSecretCode(),
                turn: 0,
                round: 1
            };

            io.sockets.sockets.get(p1.id)?.join(roomId);
            io.sockets.sockets.get(p2.id)?.join(roomId);

            io.to(roomId).emit('startGameSignal', {
                mode: mode,
                players: activeGames[roomId].players,
                turn: activeGames[roomId].turn,
                round: activeGames[roomId].round
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

        let secret = game.secretCode;
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
            game.round++;
            game.players[0].attemptsCount = 0;
            game.players[1].attemptsCount = 0;
            game.secretCode = generateSecretCode();
            
            if (game.round > 5) {
                let winnerName = "Pareggio";
                if(game.players[0].score > game.players[1].score) winnerName = game.players[0].name;
                else if(game.players[1].score > game.players[0].score) winnerName = game.players[1].name;
                
                io.to(targetRoomId).emit('roundResult', { matchWinner: winnerName, players: game.players, guess, result });
                
                // Pulisci mappe
                game.players.forEach(p => delete playerToRoomMap[p.id]);
                delete activeGames[targetRoomId];
                return;
            } else {
                game.turn = (game.turn + 1) % 2;
                io.to(targetRoomId).emit('roundResult', { roundFinished: true, nextTurn: game.turn, nextRound: game.round, players: game.players, guess, result });
                return;
            }
        }

        if (game.mode === 'coop') {
            game.turn = (game.turn + 1) % 2;
        }

        // Spedisce a tutta la stanza (incluso il mittente) per aggiornare i display dei feedback di entrambi
        io.to(targetRoomId).emit('roundResult', {
            playerId: socket.id,
            guess: guess,
            result: result,
            nextTurn: game.turn,
            currentRound: game.round,
            players: game.players
        });
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

http.listen(3000, () => {
    console.log('Server di Mastermind Pro avviato su http://localhost:3000');
});