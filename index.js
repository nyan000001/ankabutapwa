require('dotenv').config();
const express = require('express');
const app = express();
const webpush = require('web-push');
webpush.setVapidDetails('mailto:admin@example.com', process.env.PUBLIC_KEY, process.env.PRIVATE_KEY);
const subscriptions = new Map();
const notify = (title, body, arrs) => {
	const payload = JSON.stringify({ title, body });
	const options = { TTL:60 };
	for(const [sub, start, end, offset] of arrs) {
		const time = new Date(Date.now()-offset*60000);
		const mins = time.getUTCHours()*60 + time.getUTCMinutes();
		if(start < end && (mins < start || mins > end)) continue;
		if(start > end && mins < start && mins > end) continue;
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
app.use('/uploads', express.static(__dirname+'/public/uploads', { setHeaders:res => res.set('Cache-Control', 'no-store') }));
app.use(express.static(__dirname+'/public'));
const server = require('http').createServer(app);
const io = require('socket.io')(server, { maxHttpBufferSize:20e6, connectionStateRecovery:{ maxDisconnectionDuration:60000, skipMiddlewares:true } });
const defaultcolors = ['#ccc', '#000', '#fff', '#000', '#eee', '#000'];
const rooms = new Map([
	['lobby', {
		users:new Map(), password:'', colors:defaultcolors, msgs:[], emit:function (action, userid, ...args) {
			const user = this.users.get(userid);
			if(action == 'adduser') {
				io.to('?lobby').emit('addmsgs', [...this.users.keys()].map(userid2 => [userid2, userid2]), 'right');
				const limit = Date.now() - 30000000;
				user.emit('addmsgs', this.msgs.filter(msg => msg[1] > limit).map(msg => [msg[0]]), 'middle');
			} else if(action == 'removeuser') {
				io.to('?lobby').emit('removemsgs', [[userid]], 'right');
			} else if(action == 'online') {
				io.to('?lobby').emit('addmsgs', [[userid, userid]], 'right');
			} else if(action == 'offline') {
				io.to('?lobby').emit('addmsgs', [['('+userid+')', userid]], 'right');
			} else if(action == 'hear') {
				const error = msg => user.emit('addmsgs', [[msg]], 'middle');
				const msg = args[0];
				if(msg.startsWith('/')) {
					const [cmd, ...args] = msg.split(' ');
					if(cmd == '/kick') {
						if(user.data.admin) {
							for(const userid2 of args) {
								const socket2 = this.users.get(parseInt(userid2));
								if(!socket2) continue;
								socket2.kick?.('kicked by '+userid);
								socket2.leave('?lobby');
							}
						} else {
							error('only admins can kick');
						}
					} else if(cmd == '/pm') {
						const user2 = this.users.get(parseInt(args[0]));
						if(user2) {
							const msg = args.slice(1).join(' ');
							user.emit('addmsgs', [['[/[*(to '+args[0]+') '+userid+'*]: '+msg+'/]']], 'middle');
							user2.emit('addmsgs', [['[/[*(to you) '+userid+'*]: '+msg+'/]']], 'middle');
						} else {
							error('no such user');
						}
					} else {
						error('invalid command');
					}
				} else {
					const msg = '[*'+userid+'*]: '+args[0];
					io.to('?lobby').emit('addmsgs', [[msg]], 'middle');
					this.msgs.push([msg, Date.now()]);
					if(this.msgs.length > 10) {
						this.msgs.shift();
					}
				}
			}
		}
	}], ['questions', {
		users:new Map(), password:'', colors:['#f947a2', '#ffffff', '#ffdd00', '#000000', '#2da1cb', '#ffffff'], questions:[['what did you do today?'], ['what are you reading?'], ['share a song'], ['what do you want to learn?']], emit:function (action, userid, ...args) {
			const user = this.users.get(userid);
			const ask = index => {
				if(user.data.index != undefined) {
					user.emit('clear', ['top', 'middle']);
					user.leave('?'+user.data.index);
				}
				user.data.index = index < 0? this.questions.length - 1: index % this.questions.length;
				const question = this.questions[user.data.index];
				user.emit('addmsgs', [[question[0], 'question']], 'top');
				user.emit('addmsgs', question.slice(1).map(answer => [answer]), 'middle');
				user.join('?'+user.data.index);
			}
			if(action == 'adduser') {
				ask(Math.random()*this.questions.length|0);
				user.emit('setcommands', ['/previous', '/next', '/ask']);
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
						if(!question) return;
						const index = this.questions.length;
						this.questions[index] = [question];
						ask(index);
					} else {
						user.emit('addmsgs', [['invalid command']], 'middle');
					}
				} else {
					const question = this.questions[user.data.index];
					msg = question.length+' '+msg;
					question.push(msg);
					io.to('?'+user.data.index).emit('addmsgs', [[msg]], 'middle');
				}
			}
		}
	}]
]);
const hashes = new Map();
const timeouts = new Map();
io.on('connection', socket => {
	if(socket.data.dead) return;
	let roomname = 'lobby';
	try {
		const query = new URL(socket.handshake.headers.referer).search.slice(1);
		if(query) roomname = decodeURI(query);
	} catch {}
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
			do hash = crypto.randomBytes(16).toString('base64url');
			while(takenhashes.has(hash));
			hashes.set(ip, hash);
		}
		socket.data.hash = hash;
	}
	if(socket.data.userid == undefined) {
		socket.on('join', password => {
			room = rooms.get(roomname);
			if(!room) {
				socket.emit('error', 'room not found');
				return;
			}
			if(password != room.password) {
				socket.emit('error', 'wrong password');
				return;
			}
			socket.removeAllListeners('join');
			socket.removeAllListeners('host');
			if(roomname == 'lobby') {
				socket.join('?lobby');
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
			room = { users:new Map(), password:'', colors:defaultcolors };
			rooms.set(roomname, room);
			io.emit('addroom', roomname, { count:1, locked:false, colors:room.colors });
			notify('new room', roomname, [...subscriptions.values()]);
			host();
		});
	} else {
		clearTimeout(timeouts.get(socket.id));
		timeouts.delete(socket.id);
		if(!room) return;
		if(socket.data.userid) {
			get(0).emit('online', socket.data.userid);
			join();
		} else {
			host();
		}
	}
	function join() {
		const userid = socket.data.userid;
		room.users.set(userid, socket);
		socket.on('say', msg => {
			if(typeof msg != 'string') return;
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
			clearTimeout(timeouts.get(socket.id));
			timeouts.delete(socket.id);
			socket.emit('kick', reason);
			socket.removeAllListeners('say');
			socket.removeAllListeners('disconnect');
			if(get(0)) {
				die(reason);
			}
		}
	}
	function host() {
		room.users.set(0, socket);
		socket.on('kick', userids => {
			if(!Array.isArray(userids)) return;
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
			if(!Array.isArray(userids)) return;
			for(const userid of userids) {
				get(userid)?.emit('addmsgs', msgs, side);
			}
		});
		socket.on('unsend', (userids, msgids, side) => {
			if(!Array.isArray(userids)) return;
			for(const userid of userids) {
				get(userid)?.emit('removemsgs', msgids, side);
			}
		});
		socket.on('clear', (userids, sides) => {
			if(!Array.isArray(userids)) return;
			for(const userid of userids) {
				get(userid)?.emit('clear', sides);
			}
		});
		socket.on('setcommands', (userids, commands) => {
			if(!Array.isArray(userids)) return;
			for(const userid of userids) {
				get(userid)?.emit('setcommands', commands);
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
	const sendfilenames = () => {
		const path = __dirname + '/public/uploads/'+socket.data.hash;
		socket.emit('getfilenames', fs.existsSync(path)? fs.readdirSync(path, { withFileTypes: true }).map(item => socket.data.hash+'/'+item.name): []);
	}
	socket.on('getfilenames', sendfilenames);
	socket.on('upload', arrayBuffers => {
		if(!socket.data.admin) {
			socket.emit('error', 'log in to send images');
			return;
		}
		if(!Array.isArray(arrayBuffers)) return;
		const path = __dirname+'/public/uploads/';
		fs.mkdirSync(path+socket.data.hash, { recursive: true });
		const files = [];
		for(const buffer of arrayBuffers) {
			if(!Buffer.isBuffer(buffer)) continue;
			const extension =
				buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF ? 'jpg' :
				buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) ? 'png' :
				buffer.subarray(0, 6).equals(Buffer.from('GIF87a')) || buffer.subarray(0, 6).equals(Buffer.from('GIF89a')) ? 'gif' :
				buffer.subarray(0, 4).equals(Buffer.from('RIFF')) && buffer.subarray(8, 12).equals(Buffer.from('WEBP')) ? 'webp' :
				null;
			if(!extension) continue;
			const filename = socket.data.hash+'/'+crypto.createHash('sha256').update(buffer).digest('base64url')+'.'+extension;
			fs.writeFileSync(path+filename, buffer);
			files.push(path+filename);
		}
		sendfilenames();
		if(files.length) {
			setTimeout(() => files.forEach(file => fs.rmSync(file, { force: true })), 24*60*60*1000);
		}
	});
	socket.on('delete', filename => {
		if(typeof filename != 'string') return;
		const match = filename.match(/^([\w-]+)\/([\w-]+)\.([\w-]+)$/);
		if(!match) return;
		if(match[1] != socket.data.hash) return;
		fs.rm(__dirname+'/public/uploads/'+filename, { force:true }, error => {
			if(error) {
				socket.emit('error', error.message);
			} else {
				if(socket.data.userid == undefined) {
					socket.emit('delete', match[2]);
				} else {
					for(const userid of room.users.keys()) {
						get(userid)?.emit('delete', match[2]);
					}
				}
			}
		});
	});
	socket.on('subscribe', (sub, start, end, offset) => {
		if(typeof sub?.endpoint != 'string') return;
		if(typeof start != 'string') return;
		if(typeof end != 'string') return;
		if(typeof offset != 'number' || !Number.isFinite(offset)) return;
		const convert = time => {
			const [h, min] = time.split(':').map(Number);
			return h*60+min;
		}
		const arr = [sub, convert(start), convert(end), offset];
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
server.listen(process.env.PORT || 8080);
