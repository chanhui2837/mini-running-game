const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
// const fs = require('fs'); // 📝 JSON 파일 저장용 fs 모듈은 더 이상 필요하지 않습니다.
const mongoose = require('mongoose'); // 🔌 mongoose 라이브러리 추가

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 🔌 1. MongoDB 연결 설정
// ==========================================
// 로컬 MongoDB 주소입니다. 클라우드 MongoDB(Atlas)를 사용하신다면 URI를 해당 주소로 변경해주세요.
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/game_database';

mongoose.connect(MONGO_URI)
  .then(() => console.log('🍃 MongoDB 연결 성공!'))
  .catch(err => console.error('⚠️ MongoDB 연결 실패:', err.message));

// ==========================================
// 🗂️ 2. Mongoose 스키마 및 모델 정의
// ==========================================
const userSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true }, // 유저 닉네임(ID 역할)
    pw: { type: String, required: true },
    email: { type: String, required: true },
    highScore: { type: Number, default: 0 },
    hardHighScore: { type: Number, default: 0 },
    totalCoins: { type: Number, default: 0 },
    unlockedItems: {
        colors: { type: [String], default: ['#ff4d4d', '#4d79ff', '#32cd32'] },
        hats: { type: [String], default: ['없음', '야구모자'] },
        clothes: { type: [String], default: ['기본스킨', '티셔츠'] }
    },
    custom: {
        color: { type: String, default: '#ff4d4d' },
        hat: { type: String, default: '없음' },
        cloth: { type: String, default: '기본스킨' }
    }
});

const User = mongoose.model('User', userSchema);

// 매칭 및 방 관리를 위한 실시간 데이터 구조 (메모리 유지)
let rooms = {}; // 방 코드 전용 방 목록
let waitingQueue = []; // 랜덤 매칭 대기열

io.on('connection', (socket) => {
    console.log(`📡 유저 접속 완료: ${socket.id}`);

    // 유저 데이터 요청 처리 (Async/Await 적용)
    socket.on('getUserData', async (data) => {
        try {
            const user = await User.findOne({ id: data.id });
            if (user) {
                socket.emit('userDataResponse', { success: true, user });
            } else {
                socket.emit('userDataResponse', { success: false });
            }
        } catch (e) {
            console.error('getUserData 오류:', e.message);
            socket.emit('userDataResponse', { success: false });
        }
    });

    // 닉네임 중복 확인
    socket.on('checkNickname', async (data) => {
        try {
            const user = await User.findOne({ id: data.id });
            if (user) {
                socket.emit('checkNicknameResponse', { success: false }); // 이미 존재함
            } else {
                socket.emit('checkNicknameResponse', { success: true }); // 사용 가능
            }
        } catch (e) {
            console.error('checkNickname 오류:', e.message);
        }
    });

    // 회원가입
    socket.on('register', async (data) => {
        const { id, pw, email } = data;
        try {
            const existUser = await User.findOne({ id });
            if (existUser) {
                socket.emit('registerResponse', { success: false, message: "이미 존재하는 닉네임입니다." });
            } else {
                const newUser = new User({
                    id, pw, email
                    // 스키마에 정의한 default 값들이 자동으로 적용됩니다.
                });
                await newUser.save(); // DB에 저장
                console.log(`📝 신규 유저 가입 완료: ${id}`);
                socket.emit('registerResponse', { success: true });
            }
        } catch (e) {
            console.error('register 오류:', e.message);
            socket.emit('registerResponse', { success: false, message: "서버 오류가 발생했습니다." });
        }
    });

    // 로그인
    socket.on('login', async (data) => {
        const { id, pw } = data;
        try {
            const user = await User.findOne({ id });
            if (!user) {
                socket.emit('loginResponse', { success: false, message: "존재하지 않는 유저입니다." });
            } else if (user.pw !== pw) {
                socket.emit('loginResponse', { success: false, message: "비밀번호가 일치하지 않습니다." });
            } else {
                socket.emit('loginResponse', { success: true, user: user });
            }
        } catch (e) {
            console.error('login 오류:', e.message);
            socket.emit('loginResponse', { success: false, message: "로그인 중 서버 오류가 발생했습니다." });
        }
    });

    // 데이터 실시간 업데이트 및 저장
    socket.on('saveUserData', async (userData) => {
        try {
            // findOneAndUpdate를 사용하여 특정 유저의 데이터를 한 번에 갱신합니다.
            await User.findOneAndUpdate(
                { id: userData.id },
                {
                    $set: {
                        custom: userData.custom,
                        highScore: userData.highScore,
                        hardHighScore: userData.hardHighScore,
                        totalCoins: userData.totalCoins,
                        unlockedItems: userData.unlockedItems
                    }
                }
            );
            console.log(`💾 유저 데이터 동기화 완료: ${userData.id}`);
        } catch (e) {
            console.error('saveUserData 오류:', e.message);
        }
    });

    // 1. [방 코드 입력] 매칭 방식
    socket.on('joinRoomCode', (data) => {
        const { code, user } = data;
        if (!code) return;

        socket.roomCode = code;
        socket.userData = user;

        if (!rooms[code]) {
            rooms[code] = [socket];
            console.log(`🏠 [방 개설] 코드: ${code} | 방장: ${user.name}`);
        } else if (rooms[code].length === 1) {
            rooms[code].push(socket);
            const hostSocket = rooms[code][0];

            console.log(`🎮 [매칭 성공] 코드: ${code} | ${hostSocket.userData.name} VS ${user.name}`);

            hostSocket.emit('matchResult', { success: true, opponent: socket.userData });
            socket.emit('matchResult', { success: true, opponent: hostSocket.userData });

            hostSocket.join(`room_${code}`);
            socket.join(`room_${code}`);
        } else {
            socket.emit('matchResult', { success: false, message: "❌ 해당 방은 이미 만원입니다." });
        }
    });

    // 2. [랜덤 매치] 방식
    socket.on('joinRandom', (data) => {
        const { user } = data;
        socket.userData = user;
        socket.userData.id = socket.id;
        socket.isRandom = true;

        if (waitingQueue.length === 0) {
            waitingQueue.push(socket);
            console.log(`⏳ [랜덤 큐 진입] 유저: ${user.name}`);
        } else {
            const opponentSocket = waitingQueue.shift();
            
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
    waitingQueue = waitingQueue.filter(s => s.id !== socket.id);

    const code = socket.roomCode;
    if (code && rooms[code]) {
        rooms[code] = rooms[code].filter(s => s.id !== socket.id);
        if (rooms[code].length === 0) {
            delete rooms[code];
            console.log(`🗑️ 빈 방 삭제 완료 (코드: ${code})`);
        } else {
            rooms[code].forEach(s => {
                s.emit('updatePosition', { type: 'GAME_OVER', status: 'LOSER', name: socket.userData?.name || "상대방" });
            });
        }
    }
}

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`🚀 서버가 포트 ${PORT}에서 구동 중입니다.`);
});