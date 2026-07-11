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
const defaultcolors = ['#fff', '#000', '#ccc', '#000', '#eee', '#000'];
const rooms = new Map([['lobby', { users:new Map(), password:'', colors:defaultcolors }]]);
const hashes = new Map();
const timeouts = new Map();
io.on('connection', socket => {
	const roomname = decodeURI(socket.handshake.headers.referer).match(/\?(.+)/)?.[1] || 'lobby';
	if(socket.data.userid > -1) {
		clearTimeout(timeouts.get(socket.id));
		timeouts.delete(socket.id);
		const room = rooms.get(roomname);
		if(!room) return;
		if(room.host == socket.id) {
			host();
		} else {
			join(socket.data.password);
		}
	} else {
		socket.once('join', password => {
			socket.removeAllListeners('host');
			join(password);
		});
		socket.once('host', password => {
			socket.removeAllListeners('join');
			host();
		});
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
	} 
	function join(password) {
		socket.data.password = password;
		const room = rooms.get(roomname);
		if(password != room.password) {
			socket.emit('kick', 'wrong password');
			return;
		}
		if(!room) {
			socket.emit('kick', 'room not found');
			return;
		}
		const users = room.users;
		let userid = socket.data.userid;
		if(userid == undefined) {
			userid = 0;
			while(users.has(userid)) {
				userid++;
			}
			socket.data.userid = userid;
			socket.emit('join');
			users.set(userid, socket.id);
			io.emit('setcount', roomname, users.size);
			if(roomname == 'lobby') {
				socket.join('?lobby');
				io.to('?lobby').emit('addmsgs', [[userid+' has joined']], 'middle');
				io.to('?lobby').emit('addmsgs', [[[...users.keys()].join('\n'), 'users']], 'right');
			} else {
				io.to(room.host).emit('adduser', userid, socket.data.hash);
			}
		}
		socket.on('say', msg => {
			if(roomname == 'lobby') {
				io.to('?lobby').emit('addmsgs', [[userid+': '+msg]], 'middle');
			} else {
				io.to(room.host).emit('hear', userid, msg);
			}
		});
		socket.once('disconnect', reason => {
			const die = () => {
				timeouts.delete(socket.id);
				users.delete(userid);
				io.emit('setcount', roomname, users.size);
				if(roomname == 'lobby') {
					io.to('?lobby').emit('addmsgs', [[userid+' has left']], 'middle');
					io.to('?lobby').emit('addmsgs', [[[...users.keys()].join('\n'), 'users']], 'right');
				} else {
					io.to(room.host).emit('removeuser', userid);
				}
			};
			if(reason.includes('disconnect')) {
				die();
			} else {
				timeouts.set(socket.id, setTimeout(die, 60000));
			}
		});
	}
	function host() {
		let room = rooms.get(roomname);
		if(room && room.host != socket.id) {
			socket.emit('kick', 'this room is already being hosted by someone else');
			return;
		}
		if(!room) {
			socket.data.userid = 0;
			socket.emit('host', socket.data.hash);
			room = { host:socket.id, users:new Map([[0, socket.id]]), password:'', colors:defaultcolors };
			rooms.set(roomname, room);
			io.emit('addroom', roomname, { count:1, locked:false, colors:room.colors });
			notify('new room', roomname, [...subscriptions.values()]);
		}
		const users = room.users;
		const get = userid => {
			const user = io.sockets.sockets.get(users.get(userid));
			if(!user) {
				socket.emit('error', userid+' not found');
			}
			return user;
		}
		const kick = (userids, reason) => {
			for(const userid of userids) {
				const user = get(userid);
				if(!user) continue;
				user.emit('kick', reason);
				users.delete(user.data.userid);
				user.removeAllListeners();
				delete user.data.userid;
				io.emit('setcount', roomname, users.size);
			}
		}
		socket.on('kick', userids => {
			kick(userids, 'kicked');
		});
		socket.once('disconnect', reason => {
			const die = () => {
				timeouts.delete(socket.id);
				users.delete(0);
				kick([...users.keys()], 'admin has disconnected');
				rooms.delete(roomname);
				io.emit('removeroom', roomname);
			};
			if(reason.includes('disconnect')) {
				die();
			} else {
				timeouts.set(socket.id, setTimeout(die, 60000));
			}
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
