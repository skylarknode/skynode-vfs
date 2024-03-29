'use strict';

const PassThrough = require('stream').PassThrough;

const Promise = require('bluebird');
const Ftp = require('jsftp');
const Mime = require('mime');

const Tools = require('./tools');

const {UnifileError} = require('../error');

const NAME = 'ftp';

/**
 * Initialize a new FTP client
 * @param {Credentials} credentials - Access info for the FTP server
 * @return {Promise<Ftp>} a promise for a FTP client
 */
function getClient(credentials) {
	return new Promise((resolve, reject) => {
		const ftp = new Ftp(credentials);
		ftp.once('connect', () => {
			resolve(ftp);
		});
	});
}

function callAPI(session, action, client, ...params) {
	function execute(ftpClient) {
		return new Promise((resolve, reject) => {
			const handler = (err, res) => {
				if(err) reject(err);
				else resolve(res);
			};
			// Makes paths in params absolute
			const absParams = params.map((p) => {
				if(p.constructor === String) return '/' + p;
				return p;
			});
			switch (action) {
				case 'delete':
					ftpClient.raw('DELE', ...absParams, handler);
					break;
				case 'rmdir':
					ftpClient.raw('RMD', ...absParams, handler);
					break;
				case 'mkdir':
					ftpClient.raw('MKD', ...absParams, handler);
					break;
				default:
					ftpClient[action](...absParams, handler);
			}
		});
	}

	let ftp = client;
	let promise = null;
	if(client) {
		promise = execute(client);
	} else {
		promise = getClient(session.credentials)
		.then((client) => {
			ftp = client;
			// Adds a error handler on the client
			return Promise.race([
				new Promise((resolve, reject) => {
					ftp.on('error', (err) => {
						ftp.destroy();
						reject(err);
					});
				}),
				execute(ftp)
			]);
		});
	}

	return promise.catch((err) => {
		if(err.code === 530) {
			throw new UnifileError(UnifileError.EACCES, 'Invalid credentials');
		}
		throw new UnifileError(UnifileError.EIO, err.message);
	})
	.then((result) => {
		// Client was not provided, we can close it
		if(!client && result && !result.readable) {
			ftp.destroy();
		}
		return result;
	});
}

function toFileInfos(entry) {
	const isDir = entry.type === 1;
	return {
		size: parseInt(entry.size, 10),
		modified: new Date(entry.time).toISOString(),
		name: entry.name,
		isDir: isDir,
		mime: isDir ? 'application/directory' : Mime.getType(entry.name)
	};
}

/**
 * Service connector for {@link https://en.wikipedia.org/wiki/File_Transfer_Protocol|FTP} server
 */
class FtpConnector {

	/**
   * @constructor
   * @param {Object} config - Configuration object
   * @param {string} config.redirectUri - URI of the login page
   * @param {boolean} [config.showHiddenFiles=false] - Flag to show hidden files.
   * @param {ConnectorStaticInfos} [config.infos] - Connector infos to override
   */
	constructor(config,session) {
		if(!config || !config.redirectUri)
			throw new Error('You should at least set a redirectUri for this connector');

		this.redirectUri = config.redirectUri;
		this.showHiddenFile = config.showHiddenFile || false;
		this.infos = Tools.mergeInfos(config.infos || {}, {
			name: NAME,
			displayName: 'FTP',
			icon: '../assets/ftp.png',
			description: 'Edit files on a web FTP server.'
		});
		this.name = this.infos.name;

        if (session) {
            this.load(session);
        }
	}

    load(session) {
        this.session = session;

        if (session.credentials) {
            this.setCredentials(session.credentials);
        }
    }
    
	getInfos() {
		const session = this.session;

		return Object.assign({
			isLoggedIn: (session && 'credentials' in session),
			isOAuth: false,
			username: session.user
		}, this.infos);
	}

	getAuthorizeURL() {
		return Promise.resolve(this.redirectUri);
	}

	setCredentials(credentials) {
		const session = this.session;

		session.credentials = credentials;
		return Promise.resolve(credentials);
	}

	clearAccessToken() {
		this.session = {};
		return Promise.resolve();
	}

	login(loginInfos) {

		const ftpConf = {};
		try {
			Object.assign(ftpConf, Tools.parseBasicAuth(loginInfos));
			ftpConf.pass = ftpConf.password;
		} catch (e) {
			return Promise.reject(e);
		}

		return new Promise((resolve, reject) => {
			const client = new Ftp(ftpConf);
			client.on('error', (err) => {
				reject(err);
			});
			// Successful connection
			client.once('connect', () => {
				client.auth(ftpConf.user, ftpConf.password, (err) => {
					if(err) reject(err);
					else resolve();
				});
			});
		})
		.catch((err) => {
			if(err.code === 'ETIMEDOUT')
				throw new UnifileError(UnifileError.EIO, 'Unable to reach server');
			else
				throw new UnifileError(UnifileError.EACCES, 'Invalid credentials');
		})
		.then(() => {
			///Object.assign(session, ftpConf);
			///this.setCredentials(ftpConf.user);

			let credentials = {};
			Object.assign(credentials, ftpConf);
			credentials.token = ftpConf.user;
			this.setCredentials(credentials);
		});
	}

	//Filesystem commands

	readdir(path, ftpSession) {
		const session = this.session;
		return callAPI(session, 'ls', ftpSession, path)
		.then((list) => {
			return list.reduce((memo, entry) => {
				if(this.showHiddenFile || entry.name.charAt(0) != '.')
					memo.push(toFileInfos(entry));
				return memo;
			}, []);
		});
	}

	stat(path, ftpSession) {
		const session = this.session;
		return callAPI(session, 'ls', ftpSession, path)
		.then((entries) => {
			// It's a file
			if(entries.length === 1) return toFileInfos(entries[0]);
			// It's a folder
			const lastTime = entries.reduce((memo, stat) => {
				// eslint-disable-next-line no-param-reassign
				if(stat.time > memo) memo = stat.time;
				return memo;
			}, 0);
			return toFileInfos({
				name: path.split('/').pop(),
				type: 1,
				time: lastTime
			});
		});
	}

	mkdir(path, ftpSession) {
		const session = this.session;
		return callAPI(session, 'mkdir', ftpSession, path);
	}

	writeFile(path, data, ftpSession) {
		const session = this.session;
		return callAPI(session, 'put', ftpSession, new Buffer(data), path);
	}

	createWriteStream(path, ftpSession) {
		const session = this.session;
		var through = new PassThrough();
		callAPI(session, 'put', ftpSession, through, path);
		return through;
	}

	readFile(path, ftpSession) {
		const session = this.session;
		const promise = ftpSession ? Promise.resolve(ftpSession) : getClient(session.credentials);
		return promise.then((client) => {
			return callAPI(session, 'get', client, path)
			.then((fileStream) => {
				return new Promise((resolve, reject) => {
					const chunks = [];
					fileStream.on('data', (chunk) => chunks.push(chunk));
					fileStream.on('end', () => resolve(Buffer.concat(chunks)));
					fileStream.on('error', (err) => {
						client.end();
						reject(err);
					});
					fileStream.resume();
				});
			});
		});
	}

	createReadStream(path, ftpSession) {
		const session = this.session;
		var through = new PassThrough();
		callAPI(session, 'get', ftpSession, path)
		.then((fileStream) => {
			fileStream.pipe(through);
			fileStream.resume();
		})
		.catch((err) => through.emit('error', err));

		return through;
	}

	move(src, dest, ftpSession) {
		const session = this.session;
		return callAPI(session, 'rename', ftpSession, src, dest);
	}

	unlink(path, ftpSession) {
		const session = this.session;
		return callAPI(session, 'delete', ftpSession, path);
	}

	rmdir( path, ftpSession) {
		const session = this.session;
		return callAPI(session, 'rmdir', ftpSession, path);
	}

	batch( actions, message) {
		const session = this.session;
		let ftpClient;
		return getClient(session.credentials)
		.then((ftp) => {
			ftpClient = ftp;
			return Promise.each(actions, (action) => {
				const act = action.name.toLowerCase();
				switch (act) {
					case 'unlink':
					case 'rmdir':
					case 'mkdir':
						return this[act](session, action.path, ftpClient);
					case 'move':
						return this[act](session, action.path, action.destination, ftpClient);
					case 'writefile':
						return this.writeFile(session, action.path, action.content, ftpClient);
					default:
						console.warn(`Unsupported batch action: ${action.name}`);
				}
			});
		});
	}
}

///FtpConnector.name = "ftp";

module.exports = FtpConnector;
