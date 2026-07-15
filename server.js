const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

// 멀티 디바이스 동기화를 위한 중앙 집중식 유저 데이터 데이터베이스 역할
let globalUsers = {}; 

// 매칭 및 방 관리를 위한 데이터 구조
let rooms = {}; // 방 코드 전용 방 목록 (예: { "1234": [player1, player2] })
let waitingQueue = []; // 랜덤 매칭 대기열

// ===== 신규 추가: 계정 데이터 파일 영속화 (서버를 껐다 켜도 계정이 유지되도록) =====
const USERS_DATA_FILE = path.join(__dirname, 'users_data.json');

function loadUsersFromDisk() {
    try {
        if (fs.existsSync(USERS_DATA_FILE)) {
            const raw = fs.readFileSync(USERS_DATA_FILE, 'utf8');
            globalUsers = JSON.parse(raw);
            console.log(`💾 [계정 데이터 로드 완료] 총 ${Object.keys(globalUsers).length}명의 유저 정보를 불러왔습니다.`);
        } else {
            console.log('💾 저장된 계정 데이터 파일이 없어 새로 시작합니다.');
        }
    } catch (e) {
        console.log('⚠️ 계정 데이터 로드 중 오류 발생:', e.message);
    }
}

function saveUsersToDisk() {
    fs.writeFile(USERS_DATA_FILE, JSON.stringify(globalUsers, null, 2), (err) => {
        if (err) console.log('⚠️ 계정 데이터 저장 중 오류 발생:', err.message);
    });
}

loadUsersFromDisk(); // 서버 시작 시 기존 계정 데이터를 파일에서 복원

io.on('connection', (socket) => {
    console.log(`📡 유저 접속 완료: ${socket.id}`);

    // 유저 데이터 요청 처리 (브라우저 Refresh 등 대응)
    socket.on('getUserData', (data) => {
        if(globalUsers[data.id]) {
            socket.emit('userDataResponse', { success: true, user: globalUsers[data.id] });
        } else {
            socket.emit('userDataResponse', { success: false });
        }
    });

    // 닉네임 중복 확인
    socket.on('checkNickname', (data) => {
        if(globalUsers[data.id]) {
            socket.emit('checkNicknameResponse', { success: false });
        } else {
            socket.emit('checkNicknameResponse', { success: true });
        }
    });

    // 회원가입
    socket.on('register', (data) => {
        const { id, pw, email } = data;
        if(globalUsers[id]) {
            socket.emit('registerResponse', { success: false, message: "이미 존재하는 닉네임입니다." });
        } else {
            globalUsers[id] = {
                id, pw, email,
                highScore: 0,
                hardHighScore: 0,
                totalCoins: 0,
                unlockedItems: { 
                    colors: ['#ff4d4d', '#4d79ff', '#32cd32'], 
                    hats: ['없음', '야구모자'], 
                    clothes: ['기본스킨', '티셔츠'] 
                },
                custom: { color: '#ff4d4d', hat: '없음', cloth: '기본스킨' }
            };
            saveUsersToDisk(); // 신규 추가: 회원가입 즉시 파일에 저장
            socket.emit('registerResponse', { success: true });
        }
    });

    // 로그인
    socket.on('login', (data) => {
        const { id, pw } = data;
        const user = globalUsers[id];
        if(!user) {
            socket.emit('loginResponse', { success: false, message: "존재하지 않는 유저입니다." });
        } else if(user.pw !== pw) {
            socket.emit('loginResponse', { success: false, message: "비밀번호가 일치하지 않습니다." });
        } else {
            socket.emit('loginResponse', { success: true, user: user });
        }
    });

    // 데이터 실시간 업데이트 및 저장
    socket.on('saveUserData', (userData) => {
        if(globalUsers[userData.id]) {
            // 패스워드와 이메일 유지하면서 중앙 스토리지 갱신
            globalUsers[userData.id] = {
                ...globalUsers[userData.id],
                custom: userData.custom,
                highScore: userData.highScore,
                hardHighScore: userData.hardHighScore,
                totalCoins: userData.totalCoins,
                unlockedItems: userData.unlockedItems
            };
            saveUsersToDisk(); // 신규 추가: 유저 데이터 갱신 시마다 파일에 저장
        }
    });

    // 1. [방 코드 입력] 매칭 방식
    socket.on('joinRoomCode', (data) => {
        const { code, user } = data;
        if (!code) return;

        socket.roomCode = code;
        socket.userData = user;

        // 이미 해당 코드로 만들어진 방이 있는지 확인
        if (!rooms[code]) {
            // 방이 없으면 새로 개설하고 방장으로 대기
            rooms[code] = [socket];
            console.log(`🏠 [방 개설] 코드: ${code} | 방장: ${user.name}`);
            
            // 주의: 이때는 아직 혼자이므로 클라이언트에 성공을 보내지 않고 대기시킵니다.
            // 클라이언트의 타임아웃이 작동하여 "사람이 없다"고 뜨게 하거나, 
            // 아래 구조에서는 두 번째 사람이 들어올 때 비로소 둘 다 매칭 성공 이벤트를 받습니다.
        } else if (rooms[code].length === 1) {
            // 방에 한 명이 대기 중이면 참가자로 합류 (매칭 성공!)
            rooms[code].push(socket);
            const hostSocket = rooms[code][0];

            console.log(`🎮 [매칭 성공] 코드: ${code} | ${hostSocket.userData.name} VS ${user.name}`);

            // 두 플레이어에게 서로의 정보를 담아 매칭 성공 이벤트 전송
            hostSocket.emit('matchResult', { success: true, opponent: socket.userData });
            socket.emit('matchResult', { success: true, opponent: hostSocket.userData });

            // 두 소켓을 같은 socket.io 룸에 묶어줌
            hostSocket.join(`room_${code}`);
            socket.join(`room_${code}`);
        } else {
            // 방이 이미 가득 찬 경우 (3명 이상 진입 불가)
            socket.emit('matchResult', { success: false, message: "❌ 해당 방은 이미 만원입니다." });
        }
    });

    // 2. [랜덤 매치] 방식
    socket.on('joinRandom', (data) => {
        const { user } = data;
        socket.userData = user;
        socket.userData.id = socket.id;
        socket.isRandom = true;

        // 대기열에 아무도 없으면 큐에 넣고 대기
        if (waitingQueue.length === 0) {
            waitingQueue.push(socket);
            console.log(`⏳ [랜덤 큐 진입] 유저: ${user.name}`);
        } else {
            // 대기 중인 사람이 있으면 즉시 매칭
            const opponentSocket = waitingQueue.shift();
            
            // 자기 자신과의 매칭 방지
            if (opponentSocket.id === socket.id) {
                waitingQueue.push(socket);
                return;
            }

            const randomRoomId = `random_${Date.now()}`;
            socket.roomCode = randomRoomId;
            opponentSocket.roomCode = randomRoomId;

            console.log(`🎲 [랜덤 매칭 성공] ${opponentSocket.userData.name} VS ${user.name}`);

            opponentSocket.emit('matchResult', { success: true, opponent: socket.userData });
            socket.emit('matchResult', { success: true, opponent: opponentSocket.userData });

            opponentSocket.join(randomRoomId);
            socket.join(randomRoomId);
        }
    });

    // 3. 실시간 위치 및 데이터 동기화
    socket.on('playerMove', (moveData) => {
        if (socket.roomCode) {
            // 내가 속한 방의 다른 유저에게 내 위치나 게임오버 신호를 전송
            socket.to(socket.roomCode.startsWith('random_') ? socket.roomCode : `room_${socket.roomCode}`).emit('updatePosition', moveData);
        }
    });

    // 4. 매칭 취소 처리
    socket.on('cancelMatch', () => {
        cleanUpSocket(socket);
    });

    // 5. 접속 끊김 처리
    socket.on('disconnect', () => {
        console.log(`❌ 유저 접속 종료: ${socket.id}`);
        cleanUpSocket(socket);
    });
});

// 소켓 청소 공통 함수
function cleanUpSocket(socket) {
    // 랜덤 대기열에서 제거
    waitingQueue = waitingQueue.filter(s => s.id !== socket.id);

    // 코드 방에서 제거
    const code = socket.roomCode;
    if (code && rooms[code]) {
        rooms[code] = rooms[code].filter(s => s.id !== socket.id);
        if (rooms[code].length === 0) {
            delete rooms[code];
            console.log(`🗑️ 빈 방 삭제 완료 (코드: ${code})`);
        } else {
            // 방에 남은 사람에게 상대방이 나갔음을 알림
            rooms[code].forEach(s => {
                s.emit('updatePosition', { type: 'GAME_OVER', status: 'LOSER', name: socket.userData?.name || "상대방" });
            });
        }
    }
}

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🚀 서버가 http://localhost:${PORT} 에서 구동 중입니다.`);
});