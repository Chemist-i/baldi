// ================================================================
// server.js - Авторитетний сервер карткової гри.
// Тримає ВЕСЬ стан гри (руки, стіл, чия черга) і надсилає кожному
// гравцю лише ту інформацію, яку він має бачити (свою руку +
// кількість карт у інших, а не самі карти).
// ================================================================

const http = require('http');       // вбудований HTTP-сервер (роздає index.html)
const fs = require('fs');           // читання файлів з диска
const path = require('path');       // побудова шляхів до файлів
const WebSocket = require('ws');    // WebSocket-сервер (npm install ws)

const PORT = process.env.PORT || 3000; // порт сервера (можна перевизначити змінною середовища)

/* ================================================================
   БЛОК 1. Ігрова логіка (ідентична перевіреній однопристрійній версії)
   ================================================================ */

const SUITS = ['♠','♣','♦','♥']; // ♥ - завжди козир, ♠ - особлива масть (див. canCover)

const RANKS_36 = [
  {r:'6',v:6},{r:'7',v:7},{r:'8',v:8},{r:'9',v:9},{r:'10',v:10},
  {r:'J',v:11},{r:'Q',v:12},{r:'K',v:13},{r:'A',v:14}
];
const RANKS_52 = [
  {r:'2',v:2},{r:'3',v:3},{r:'4',v:4},{r:'5',v:5},{r:'6',v:6},{r:'7',v:7},
  {r:'8',v:8},{r:'9',v:9},{r:'10',v:10},{r:'J',v:11},{r:'Q',v:12},{r:'K',v:13},{r:'A',v:14}
];

// Будує повну колоду вказаного розміру (масив {suit, rank, value})
function buildDeck(size){
  const ranks = size === 52 ? RANKS_52 : RANKS_36; // обираємо набір номіналів
  const deck = [];
  for(const suit of SUITS){
    for(const rk of ranks){
      deck.push({ suit, rank: rk.r, value: rk.v });
    }
  }
  return deck;
}

// Перемішує масив на місці (Фішер-Єйтс)
function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]] = [arr[j],arr[i]];
  }
  return arr;
}

// Текст карти для відображення, напр. "10♥"
function cardLabel(c){ return c.rank + c.suit; }

// Чи карта "червона" (для кольору в UI)
function isRed(c){ return c.suit==='♥' || c.suit==='♦'; }

// Головне правило: чи можна карткою cand накрити карту top
function canCover(top, cand){
  if(top.suit === '♠'){
    // Виняток: піку можна накрити ЛИШЕ пікою більшого номіналу (козир тут не діє)
    return cand.suit === '♠' && cand.value > top.value;
  }
  if(cand.suit === top.suit){
    return cand.value > top.value; // та сама масть - потрібен більший номінал
  }
  if(cand.suit === '♥'){
    return true; // чирва - козир, б'є будь-що (крім піки, обробленої вище)
  }
  return false;
}

/* ================================================================
   БЛОК 2. Кімнати (rooms) - кожна кімната = окрема партія
   ================================================================ */

const rooms = new Map(); // код кімнати (string) -> об'єкт кімнати

// Генерує унікальний 4-літерний код кімнати
function makeRoomCode(){
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // без O/I, щоб не плутати з 0/1
  let code;
  do {
    code = Array.from({length:4}, () => letters[Math.floor(Math.random()*letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// Створює нову порожню кімнату з вказаним розміром колоди
function createRoom(deckSize){
  const room = {
    code: makeRoomCode(),
    deckSize: deckSize === 52 ? 52 : 36,
    players: [],        // {ws, name, hand:[], out:false}
    tablePile: [],       // {card, ownerIdx}[] - черга карт поточного раунду
    currentIdx: 0,       // чий зараз хід
    attackerIdx: 0,      // хто починав поточний раунд
    lastCovererIdx: null,// хто останній успішно поклав карту
    started: false,
    finished: false,
    log: [],             // останні події для показу в чаті/журналі
    cleanupTimeout: null // id таймера відкладеного видалення кімнати (null = не заплановано)
  };
  rooms.set(room.code, room);
  return room;
}

// Скільки часу чекати перед видаленням кімнати після того, як усі гравці вийшли
const ROOM_CLEANUP_DELAY_MS = 5 * 60 * 1000; // 5 хвилин

// Чи всі гравці кімнати зараз відключені (ws === null в кожного)
function allDisconnected(room){
  return room.players.every(p => !p.ws);
}

// Планує видалення кімнати з пам'яті через ROOM_CLEANUP_DELAY_MS,
// якщо до того часу ніхто так і не повернувся
function scheduleRoomCleanup(room){
  if(room.cleanupTimeout) return; // вже заплановано - не дублюємо таймер
  room.cleanupTimeout = setTimeout(() => {
    if(allDisconnected(room)){ // перевіряємо ще раз на момент спрацювання (раптом хтось зайшов)
      rooms.delete(room.code);
      console.log(`Кімнату ${room.code} видалено з пам'яті (усі вийшли, минуло ${ROOM_CLEANUP_DELAY_MS/60000} хв).`);
    } else {
      room.cleanupTimeout = null; // хтось повернувся - скасовуємо, таймер більше не актуальний
    }
  }, ROOM_CLEANUP_DELAY_MS);
}

// Скасовує заплановане видалення (викликати, коли в кімнату хтось знову заходить/лишається)
function cancelRoomCleanup(room){
  if(room.cleanupTimeout){
    clearTimeout(room.cleanupTimeout);
    room.cleanupTimeout = null;
  }
}

function activePlayerCount(room){
  return room.players.filter(p => !p.out).length;
}

// Наступний АКТИВНИЙ (не вибулий) гравець по колу
function nextActiveIdx(room, fromIdx){
  const n = room.players.length;
  let i = fromIdx;
  for(let step=0; step<n; step++){
    i = (i+1) % n;
    if(!room.players[i].out) return i;
  }
  return fromIdx;
}

function topOfTable(room){
  const pile = room.tablePile;
  return pile.length ? pile[pile.length-1].card : null;
}

function addLog(room, msg){
  room.log.unshift(msg);
  if(room.log.length > 50) room.log.pop(); // не тримаємо історію нескінченно
}

// Роздає нову партію тим самим гравцям кімнати (новий розклад, ті самі місця)
function startGame(room){
  let deck = shuffle(buildDeck(room.deckSize));
  const n = room.players.length;
  const perPlayer = Math.floor(deck.length / n); // ділимо порівну, залишок не використовується
  room.players.forEach(p => {
    p.hand = deck.splice(0, perPlayer);
    p.out = false;
  });
  room.tablePile = [];
  room.attackerIdx = Math.floor(Math.random()*n); // жеребкування першого гравця
  room.currentIdx = room.attackerIdx;
  room.lastCovererIdx = null;
  room.finished = false;
  room.started = true;
  room.log = [];
  addLog(room, `Гру розпочато. Колода: ${room.deckSize} карт. Починає ${room.players[room.attackerIdx].name}.`);
}

// Перевіряє спорожніння руки гравця; виставляє прапори програшу/нічиєї
function checkEmptyHand(room, player){
  if(player.hand.length > 0) return;
  player.out = true;
  addLog(room, `${player.name} лишився без карт і виходить з гри.`);
  const stillIn = room.players.filter(p => !p.out);
  if(stillIn.length === 0){
    addLog(room, `Нічия! Усі гравці спорожнили руки одночасно.`);
    room.finished = true;
  } else if(stillIn.length === 1){
    addLog(room, `${stillIn[0].name} лишився останнім з картами і ПРОГРАВ гру.`);
    room.finished = true;
  }
}

// Викликається після кожного УСПІШНОГО викладання карти (відкриття чи накриття)
function afterSuccessfulPlay(room){
  if(room.tablePile.length >= activePlayerCount(room)){
    addLog(room, `Відбій! На столі назбиралось ${room.tablePile.length} карт. Стіл очищено.`);
    room.tablePile = [];
    room.attackerIdx = room.lastCovererIdx;
    room.currentIdx = room.lastCovererIdx; // ходить той, хто поклав останню (верхню) карту
  } else {
    room.currentIdx = nextActiveIdx(room, room.currentIdx);
  }
}

// Дія: гравець відкриває раунд (стіл порожній) будь-якою карткою
function actionPlayOpening(room, playerIdx, cardIdx){
  if(room.finished) return 'Гра вже завершена.';
  if(playerIdx !== room.currentIdx) return 'Зараз не ваш хід.';
  if(room.tablePile.length !== 0) return 'Стіл не порожній — використайте "Накрити".';
  const player = room.players[playerIdx];
  if(cardIdx < 0 || cardIdx >= player.hand.length) return 'Невірний номер карти.';
  const card = player.hand.splice(cardIdx,1)[0];
  room.tablePile.push({ card, ownerIdx: playerIdx });
  room.lastCovererIdx = playerIdx;
  addLog(room, `${player.name} відкриває раунд картою ${cardLabel(card)}.`);
  checkEmptyHand(room, player);
  if(!room.finished) afterSuccessfulPlay(room);
  return null; // без помилки
}

// Дія: гравець накриває верхню карту столу
function actionCover(room, playerIdx, cardIdx){
  if(room.finished) return 'Гра вже завершена.';
  if(playerIdx !== room.currentIdx) return 'Зараз не ваш хід.';
  const top = topOfTable(room);
  if(top === null) return 'Стіл порожній — спочатку відкрийте раунд.';
  const player = room.players[playerIdx];
  if(cardIdx < 0 || cardIdx >= player.hand.length) return 'Невірний номер карти.';
  const cand = player.hand[cardIdx];
  if(!canCover(top, cand)) return 'Цю карту накрити не можна за правилами.';
  player.hand.splice(cardIdx,1);
  room.tablePile.push({ card: cand, ownerIdx: playerIdx });
  room.lastCovererIdx = playerIdx;
  addLog(room, `${player.name} накриває картою ${cardLabel(cand)}.`);
  checkEmptyHand(room, player);
  if(!room.finished) afterSuccessfulPlay(room);
  return null;
}

// Дія: гравець не може/не хоче накривати - забирає найстарішу карту столу
function actionTake(room, playerIdx){
  if(room.finished) return 'Гра вже завершена.';
  if(playerIdx !== room.currentIdx) return 'Зараз не ваш хід.';
  if(room.tablePile.length === 0) return 'Стіл порожній, брати нема чого.';
  const player = room.players[playerIdx];
  const taken = room.tablePile.shift(); // найстаріша (перша покладена) карта
  player.hand.push(taken.card);
  addLog(room, `${player.name} забирає карту ${cardLabel(taken.card)} (клав ${room.players[taken.ownerIdx].name}).`);
  room.currentIdx = nextActiveIdx(room, playerIdx); // хід - до наступного гравця по колу
  return null;
}

/* ================================================================
   БЛОК 3. Розсилка персоналізованого стану кожному гравцю
   ================================================================ */

function broadcastState(room){
  const top = topOfTable(room);
  room.players.forEach((viewer, viewerIdx) => {
    if(!viewer.ws || viewer.ws.readyState !== WebSocket.OPEN) return; // гравець відключений

    const isYourTurn = viewerIdx === room.currentIdx && room.started && !room.finished;

    const payload = {
      type: 'state',
      roomCode: room.code,
      started: room.started,
      finished: room.finished,
      youIdx: viewerIdx,
      isYourTurn,
      // Власна рука: показуємо карти + чи дозволено її покласти зараз (для підсвітки, як у прототипі)
      yourHand: viewer.hand.map(c => ({
        label: cardLabel(c),
        red: isRed(c),
        legal: isYourTurn && (top === null || canCover(top, c))
      })),
      // Інші гравці: ім'я, кількість карт (НЕ самі карти - це і є прихована інформація), статус
      players: room.players.map((p,i) => ({
        name: p.name,
        count: p.hand.length,
        out: p.out,
        isYou: i === viewerIdx,
        isCurrent: i === room.currentIdx,
        connected: !!p.ws && p.ws.readyState === WebSocket.OPEN
      })),
      // Стіл - публічна інформація, видно всім однаково
      table: room.tablePile.map((entry,i) => ({
        label: cardLabel(entry.card),
        red: isRed(entry.card),
        ownerName: room.players[entry.ownerIdx].name,
        isTop: i === room.tablePile.length - 1,
        isOldest: i === 0
      })),
      needed: activePlayerCount(room), // скільки карт на столі треба для відбою
      log: room.log.slice(0, 30)
    };
    viewer.ws.send(JSON.stringify(payload));
  });
}

/* ================================================================
   БЛОК 4. HTTP + WebSocket сервер
   ================================================================ */

const server = http.createServer((req, res) => {
  // Роздаємо єдиний файл клієнта public/index.html на будь-який шлях
  const filePath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(filePath, (err, data) => {
    if(err){ res.writeHead(500); res.end('Не вдалося прочитати index.html'); return; }
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server }); // WebSocket "прикріплений" до того ж HTTP-сервера

wss.on('connection', (ws) => {
  let room = null;      // кімната, до якої приєднався цей сокет
  let playerIdx = -1;   // індекс гравця в room.players

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e){ return; } // ігноруємо биті повідомлення

    if(msg.type === 'create'){
      room = createRoom(msg.deckSize);
      playerIdx = 0;
      room.players.push({ ws, name: (msg.name || 'Гравець 1').slice(0,20), hand: [], out:false });
      ws.send(JSON.stringify({ type:'joined', roomCode: room.code, playerIdx, isHost:true }));
      broadcastState(room);

    } else if(msg.type === 'join'){
      room = rooms.get((msg.code || '').toUpperCase());
      if(!room){ ws.send(JSON.stringify({type:'error', message:'Кімнату не знайдено. Перевірте код.'})); return; }
      cancelRoomCleanup(room); // хтось прийшов - скасовуємо заплановане видалення
      if(room.started){ ws.send(JSON.stringify({type:'error', message:'Гра в цій кімнаті вже почалась.'})); return; }
      if(room.players.length >= 6){ ws.send(JSON.stringify({type:'error', message:'У кімнаті вже 6 гравців (максимум).'})); return; }
      playerIdx = room.players.length;
      room.players.push({ ws, name: (msg.name || `Гравець ${playerIdx+1}`).slice(0,20), hand: [], out:false });
      ws.send(JSON.stringify({ type:'joined', roomCode: room.code, playerIdx, isHost:false }));
      broadcastState(room);

    } else if(msg.type === 'start'){
      if(!room) return;
      if(playerIdx !== 0){ ws.send(JSON.stringify({type:'error', message:'Почати гру може лише хост (перший гравець).'})); return; }
      if(room.players.length < 2){ ws.send(JSON.stringify({type:'error', message:'Потрібно щонайменше 2 гравці.'})); return; }
      startGame(room);
      broadcastState(room);

    } else if(msg.type === 'restart'){
      if(!room) return;
      if(playerIdx !== 0){ ws.send(JSON.stringify({type:'error', message:'Перезапустити може лише хост.'})); return; }
      startGame(room); // нова роздача тим самим складом гравців
      broadcastState(room);

    } else if(msg.type === 'playOpening'){
      if(!room) return;
      const err = actionPlayOpening(room, playerIdx, msg.cardIdx);
      if(err) ws.send(JSON.stringify({type:'error', message:err}));
      broadcastState(room);

    } else if(msg.type === 'cover'){
      if(!room) return;
      const err = actionCover(room, playerIdx, msg.cardIdx);
      if(err) ws.send(JSON.stringify({type:'error', message:err}));
      broadcastState(room);

    } else if(msg.type === 'take'){
      if(!room) return;
      const err = actionTake(room, playerIdx);
      if(err) ws.send(JSON.stringify({type:'error', message:err}));
      broadcastState(room);
    }
  });

  ws.on('close', () => {
    // Гравець закрив вкладку/втратив зв'язок - позначаємо це в журналі й розсилаємо стан далі
    if(room && playerIdx >= 0 && room.players[playerIdx]){
      addLog(room, `${room.players[playerIdx].name} відключився.`);
      room.players[playerIdx].ws = null;
      broadcastState(room);

      // Якщо це був останній підключений гравець - плануємо видалення кімнати через 5 хв
      if(allDisconnected(room)){
        scheduleRoomCleanup(room);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Сервер карткової гри запущено: http://localhost:${PORT}`);
  console.log(`Для гри по локальній мережі - дізнайтесь свою IP-адресу і дайте іншим http://<ваша-IP>:${PORT}`);
});
