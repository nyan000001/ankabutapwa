require('dotenv').config();
const { randomBytes } = require('crypto');
const express = require('express');
const app = express();
const webpush = require('web-push');
webpush.setVapidDetails('mailto:admin@example.com', process.env.PUBLIC_KEY, process.env.PRIVATE_KEY);
const subscriptions = new Map();
app.use(express.json());
const notify = (title, body, subs) => {
	const payload = JSON.stringify({ title, body });
	const options = { TTL:60 };
	for(const sub of subs) {
		webpush.sendNotification(sub, payload, options).catch(error => {
			if(error.statusCode == 404 || error.statusCode == 410) {
				subscriptions.delete(sub.endpoint);
			}
		});
	}
}
app.post('/subscribe', (req, res) => {
	const sub = req.body;
	if(sub.endpoint) {
		subscriptions.set(sub.endpoint, sub);
		notify('test', 'boo!', [sub]);
	}
});
app.post('/unsubscribe', (req, res) => {
	const sub = req.body;
	if(sub.endpoint) {
		subscriptions.delete(sub.endpoint);
	}
});
app.use(express.static(__dirname+'/public'));
const server = require('http').createServer(app);
const io = require('socket.io')(server, { connectionStateRecovery:{ maxDisconnectionDuration:60000, skipMiddlewares:true } });
const defaultcolors = ['#ccc', '#000', '#fff', '#000', '#eee', '#000'];
const rooms = new Map([
	['lobby', {
		users:new Map(), password:'', colors:defaultcolors, emit:function (action, userid, ...args) {
			if(action == 'adduser') {
				io.to('?lobby').emit('addmsgs', [...this.users.keys()].map(id => [id.toString(), id.toString()]), 'right');
			} else if(action == 'removeuser') {
				io.to('?lobby').emit('removemsgs', [[userid]], 'right');
			} else if(action == 'online') {
				io.to('?lobby').emit('addmsgs', [[userid, userid]], 'right');
			} else if(action == 'offline') {
				io.to('?lobby').emit('addmsgs', [['('+userid+')', userid]], 'right');
			} else if(action == 'hear') {
				io.to('?lobby').emit('addmsgs', [['[*'+userid+'*]: '+args[0]]], 'middle');
			}
		}
	}]
]);
const hashes = new Map();
const timeouts = new Map();
io.on('connection', socket => {
	if(socket.data.kicked) return;
	const roomname = decodeURI(socket.handshake.headers.referer).match(/\?(.+)/)?.[1] || 'lobby';
	let room = rooms.get(roomname);
	const get = userid => {
		if(userid == 0 && room.emit) {
			return room;
		}
		const user = io.sockets.sockets.get(room.users.get(userid));
		if(!user && socket.data.userid == 0) {
			socket.emit('error', userid+' not found');
		}
		return user;
	}
	if(!socket.recovered) {
		socket.emit('hi', [...rooms].map(([roomname, room]) =>
			[roomname, { count:room.users.size, colors:room.colors, locked:Boolean(room.password) }]
		), process.env.PUBLIC_KEY);
		const ip = socket.handshake.address; //socket.handshake.headers['x-forwarded-for'].split(',')[0];
		let hash = hashes.get(ip);
		if(!hash) {
			const takenhashes = new Set(hashes.values());
			do hash = randomBytes(16).toString('hex');
			while(takenhashes.has(hash));
			hashes.set(ip, hash);
		}
		socket.data.hash = hash;
	}
	if(socket.data.userid == undefined) {
		socket.on('join', password => {
			room = rooms.get(roomname);
			if(password != room.password) {
				socket.emit('error', 'wrong password');
				return;
			}
			socket.removeAllListeners('join');
			socket.removeAllListeners('host');
			if(roomname == 'lobby') {
				socket.join('?lobby');
			}
			if(!room) {
				socket.emit('error', 'room not found');
				return;
			}
			let userid = 1;
			while(room.users.has(userid)) {
				userid++;
			}
			socket.data.userid = userid;
			socket.emit('join');
			room.users.set(userid, socket.id);
			io.emit('setcount', roomname, room.users.size);
			get(0).emit('adduser', userid, socket.data.hash);
			join();
		});
		socket.on('host', () => {
			if(rooms.get(roomname)) {
				socket.emit('error', 'this room is already being hosted by someone else');
				return;
			}
			socket.removeAllListeners('join');
			socket.removeAllListeners('host');
			socket.data.userid = 0;
			socket.emit('host', socket.data.hash);
			room = { users:new Map([[0, socket.id]]), password:'', colors:defaultcolors };
			rooms.set(roomname, room);
			io.emit('addroom', roomname, { count:1, locked:false, colors:room.colors });
			notify('new room', roomname, [...subscriptions.values()]);
			host();
		});
	} else {
		clearTimeout(timeouts.get(socket.id));
		timeouts.delete(socket.id);
		if(!room) return;
		if(room.users.get(0) == socket.id) {
			host();
		} else {
			get(0).emit('online', userid);
			join();
		}
	}
	function join() {
		const userid = socket.data.userid;
		socket.on('say', msg => {
			get(0).emit('hear', userid, msg);
		});
		socket.once('disconnect', reason => {
			const die = () => {
				timeouts.delete(socket.id);
				room.users.delete(userid);
				io.emit('setcount', roomname, room.users.size);
				get(0).emit('removeuser', userid);
			};
			reason.includes('disconnect')? die(): timeouts.set(socket.id, setTimeout(die, 60000));
		});
	}
	function host() {
		const kick = (userids, reason) => {
			for(const userid of userids) {
				const user = get(userid);
				if(!user) continue;
				user.emit('kick', reason);
				room.users.delete(user.data.userid);
				user.removeAllListeners();
				user.data.kicked = true;
				io.emit('setcount', roomname, room.users.size);
			}
		}
		socket.on('kick', userids => {
			kick(userids, 'kicked');
		});
		socket.once('disconnect', reason => {
			const die = () => {
				timeouts.delete(socket.id);
				room.users.delete(0);
				kick([...room.users.keys()], 'admin has disconnected');
				rooms.delete(roomname);
				io.emit('removeroom', roomname);
			};
			reason.includes('disconnect')? die(): timeouts.set(socket.id, setTimeout(die, 60000));
		});
		socket.on('send', (userids, msgs, side) => {
			for(const userid of userids) {
				get(userid)?.emit('addmsgs', msgs, side);
			}
		});
		socket.on('unsend', (userids, msgids, side) => {
			for(const userid of userids) {
				get(userid)?.emit('removemsgs', msgids, side);
			}
		});
		socket.on('clear', (userids, sides) => {
			for(const userid of userids) {
				get(userid)?.emit('clear', sides);
			}
		});
		socket.on('setcolors', colors => {
			room.colors = colors;
			io.emit('setcolors', roomname, colors);
		});
		socket.on('setpassword', password => {
			room.password = password;
			io.emit('setlock', roomname, Boolean(password));
		});
	}
});
server.listen(8080);
