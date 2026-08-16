require('dotenv').config();
const { randomBytes } = require('crypto');
const express = require('express');
const app = express();
const webpush = require('web-push');
webpush.setVapidDetails('mailto:admin@example.com', process.env.PUBLIC_KEY, process.env.PRIVATE_KEY);
const subscriptions = new Map();
const notify = (title, body, arrs) => {
	const payload = JSON.stringify({ title, body });
	const options = { TTL:60 };
	let time = new Date();
	time = time.getHours()*60+time.getMinutes();
	for(const [sub, start, end] of arrs) {
		if(start < end && (time < start || time > end)) continue;
		if(start > end && (time > start || time < end)) continue;
		webpush.sendNotification(sub, payload, options).catch(error => {
			if(error.statusCode == 404 || error.statusCode == 410) {
				subscriptions.delete(sub.endpoint);
			}
		});
	}
}
const crypto = require('crypto');
const fs = require('fs');
fs.rmSync(__dirname+'/public/uploads', { recursive:true, force:true });
fs.mkdirSync(__dirname+'/public/uploads');
app.use(express.static(__dirname+'/public'));
const server = require('http').createServer(app);
const io = require('socket.io')(server, { connectionStateRecovery:{ maxDisconnectionDuration:60000, skipMiddlewares:true } });
const defaultcolors = ['#ccc', '#000', '#fff', '#000', '#eee', '#000'];
const rooms = new Map([
	['lobby', {
		users:new Map(), password:'', colors:defaultcolors, emit:function (action, userid, ...args) {
			if(action == 'adduser') {
				io.to('?lobby').emit('addmsgs', [...this.users.keys()].map(userid2 => [userid2.toString(), userid2.toString()]), 'right');
			} else if(action == 'removeuser') {
				io.to('?lobby').emit('removemsgs', [[userid]], 'right');
			} else if(action == 'online') {
				io.to('?lobby').emit('addmsgs', [[userid, userid]], 'right');
			} else if(action == 'offline') {
				io.to('?lobby').emit('addmsgs', [['('+userid+')', userid]], 'right');
			} else if(action == 'hear') {
				const user = this.users.get(userid);
				const error = msg => user.emit('addmsgs', [[msg]], 'middle');
				const msg = args[0];
				if(msg.startsWith('/')) {
					const [cmd, ...args] = msg.split(' ');
					if(cmd == '/kick') {
						if(user.data.admin) {
							for(const userid2 of args) {
								this.users.get(parseInt(userid2))?.kick?.('kicked by '+userid);
							}
						} else {
							error('only admins can kick');
						}
					} else {
						error('invalid command');
					}
				} else {
					io.to('?lobby').emit('addmsgs', [['[*'+userid+'*]: '+args[0]]], 'middle');
				}
			}
		}
	}], ['questions', {
		users:new Map(), password:'', colors:defaultcolors, questions:[['what did you do today?'], ['what are you reading?'], ['share a song'], ['what do you want to learn?']], emit:function (action, userid, ...args) {
			const user = this.users.get(userid);
			const ask = index => {
				if(user.data.index != undefined) {
					user.emit('clear', ['top', 'middle']);
					user.leave('?'+user.data.index);
				}
				user.data.index = index < 0? this.questions.length - 1: index % this.questions.length;
				user.emit('addmsgs', [[this.questions[user.data.index][0]]], 'top');
			}
			if(action == 'adduser') {
				ask(Math.random()*this.questions.length|0);
			} else if(action == 'hear') {
				let msg = args[0];
				if(msg.startsWith('/')) {
					const [cmd, ...args] = msg.split(' ');
					if(cmd == '/next') {
						ask(user.data.index+1);
					} else if(cmd == '/previous') {
						ask(user.data.index-1);
					} else if(cmd == '/ask') {
						const question = args.join(' ');
						user.data.index = this.questions.length;
						questions[user.data.index] = [user.data.question];
						user.emit('addmsgs', [[question]], 'top');
						user.join('?'+user.data.index);
					} else {
						user.emit('addmsgs', [['invalid command']], 'middle');
					}
				} else {
					const question = this.questions[user.data.index];
					msg = question.length+' '+msg;
					question.push(msg);
					if(!user.rooms.has('?'+user.data.index)) {
						user.emit('addmsgs', question.slice(1).map(answer => [answer]), 'middle');
					}
					io.to('?'+user.data.index).emit('addmsgs', [[msg]], 'middle');
					user.join('?'+user.data.index);
				}
			}
		}
	}]
]);
const hashes = new Map();
const timeouts = new Map();
io.on('connection', socket => {
	if(socket.data.dead) return;
	const roomname = decodeURI(socket.handshake.headers.referer).match(/\?(.+)/)?.[1] || 'lobby';
	let room = rooms.get(roomname);
	const get = userid => {
		if(userid == 0 && room.emit) {
			return room;
		}
		const user = room.users.get(userid);
		if(!room.users.get(userid) && socket.data.userid == 0) {
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
			join();
			get(0).emit('adduser', userid, socket.data.hash);
			io.emit('setcount', roomname, room.users.size);
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
			room = { users:new Map([[0, socket]]), password:'', colors:defaultcolors };
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
		room.users.set(userid, socket);
		socket.on('say', msg => {
			get(0).emit('hear', userid, msg);
		});
		const die = reason => {
			get(0).emit('removeuser', userid, reason);
			room.users.delete(userid);
			io.emit('setcount', roomname, room.users.size);
			socket.data.dead = true;
		};		
		socket.once('disconnect', reason => {
			if(reason.includes('disconnect')) {
				die(reason);
			} else {
				get(0).emit('offline', userid);
				timeouts.set(socket.id, setTimeout(() => {
					timeouts.delete(socket.id);
					die(reason);
				}, 60000));
			}
		});
		socket.kick = reason => {
			socket.emit('kick', reason);
			socket.removeAllListeners('say');
			socket.removeAllListeners('disconnect');
			die(reason);
		}
	}
	function host() {
		socket.on('kick', userids => {
			for(const userid of userids) {
				get(userid)?.kick?.('kicked');
			}
		});
		socket.once('disconnect', reason => {
			const die = () => {
				timeouts.delete(socket.id);
				room.users.delete(0);
				for(const userid of room.users.keys()) {
					get(userid)?.kick('admin has disconnected');
				}
				rooms.delete(roomname);
				io.emit('removeroom', roomname);
			};
			reason.includes('disconnect')? die(): timeouts.set(socket.id, setTimeout(die, 30000));
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
		socket.on('setcommands', (userids, commands) => {
			for(const userid of userids) {
				io.emit('setcommands', commands);
			}
		});
		socket.on('setcolors', (userids, colors) => {
			room.colors = colors;
			io.emit('setcolors', roomname, colors);
		});
		socket.on('setpassword', password => {
			room.password = password;
			io.emit('setlock', roomname, Boolean(password));
		});
	}
	socket.on('pic', arrayBuffers => {
		if(!socket.data.admin) return;
		const images = [];
		for(const arrayBuffer of arrayBuffers) {
			buffer = Buffer.from(arrayBuffer);
			const extension =
				buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF ? 'jpg' :
				buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) ? 'png' :
				buffer.subarray(0, 6).equals(Buffer.from('GIF87a')) || buffer.subarray(0, 6).equals(Buffer.from('GIF89a')) ? 'gif' :
				buffer.subarray(0, 4).equals(Buffer.from('RIFF')) && buffer.subarray(8, 12).equals(Buffer.from('WEBP')) ? 'webp' :
				null;
			if(!extension) return;
			const name = crypto.createHash('sha256').update(buffer).digest('hex')+'.'+extension;
			const path = __dirname+'/public/uploads/'+name;
			fs.writeFile(path, buffer, () => {
				setTimeout(() => fs.rm(path, { force:true }, () => {}), 24*60*60*1000);
			});
			images.push('[:'+name+':]');
		}
		get(0).emit('hear', socket.data.userid, images.join(''));
	});
	socket.on('subscribe', (sub, start, end, time) => {
		const diff = Date.now()-time;
		const convert = time => {
			const [h, min] = time.split(':').map(Number);
			return h*60+min+diff;
		}
		const arr = [sub, convert(start), convert(end)];
		subscriptions.set(sub.endpoint, arr);
		notify('test', 'boo!', [arr]);
	});
	socket.on('unsubscribe', endpoint => {
		subscriptions.delete(endpoint);
	});
	socket.on('login', password => {
		if(password == process.env.PASSWORD) {
			socket.data.admin = true;
			socket.emit('login');
		} else {
			socket.emit('error', 'invalid password');
		}
	});
});
server.listen(8080);
