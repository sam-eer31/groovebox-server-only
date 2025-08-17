const { Server } = require('socket.io');
const express = require('express');
const http = require('http');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

class PublicMusicRoomServer {
    constructor(port = process.env.PORT || 3001) {
        this.port = port;
        this.rooms = new Map(); // roomCode -> roomData
        this.userSockets = new Map(); // socketId -> userData
        this.roomCodes = new Set(); // Track existing room codes
        
        // File storage setup
        this.uploadsDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(this.uploadsDir)) {
            fs.mkdirSync(this.uploadsDir, { recursive: true });
        }
        
        // Configure multer for file uploads
        this.storage = multer.diskStorage({
            destination: (req, file, cb) => {
                cb(null, this.uploadsDir);
            },
            filename: (req, file, cb) => {
                // Generate unique filename: timestamp_originalname
                const uniqueSuffix = Date.now() + '_' + Math.round(Math.random() * 1E9);
                cb(null, uniqueSuffix + '_' + file.originalname);
            }
        });
        
        this.upload = multer({ 
            storage: this.storage,
            fileFilter: (req, file, cb) => {
                // Only allow audio files
                if (file.mimetype.startsWith('audio/')) {
                    cb(null, true);
                } else {
                    cb(new Error('Only audio files are allowed!'), false);
                }
            },
            limits: {
                fileSize: 50 * 1024 * 1024 // 50MB limit
            }
        });
        
        // Create Express app for health checks
        this.app = express();
        this.app.use(cors());
        this.app.use(express.json());
        this.app.use(express.static(this.uploadsDir)); // Serve uploaded files
        
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                rooms: this.rooms.size,
                users: this.userSockets.size,
                uptime: process.uptime()
            });
        });
        
        // Root endpoint
        this.app.get('/', (req, res) => {
            res.json({
                service: 'GrooveBox Music Rooms Server',
                version: '1.0.0',
                status: 'running'
            });
        });
        
        // File upload endpoint
        this.app.post('/upload-song', this.upload.single('song'), (req, res) => {
            try {
                if (!req.file) {
                    return res.status(400).json({ error: 'No file uploaded' });
                }
                
                const { roomCode, songId, title, artist, album, duration } = req.body;
                
                // Store file info
                const uploadedSong = {
                    _id: songId,
                    title: title || req.file.originalname,
                    artist: artist || 'Unknown Artist',
                    album: album || 'Unknown Album',
                    duration: duration || 0,
                    filename: req.file.filename,
                    filePath: `/uploads/${req.file.filename}`,
                    uploadedAt: new Date(),
                    roomCode: roomCode
                };
                
                res.json({
                    success: true,
                    song: uploadedSong,
                    message: 'Song uploaded successfully'
                });
                
            } catch (error) {
                console.error('Upload error:', error);
                res.status(500).json({ error: 'Upload failed' });
            }
        });
        
        // Music streaming endpoint - now serves actual uploaded files
        this.app.get('/stream/:roomCode/:songId', (req, res) => {
            const { roomCode, songId } = req.params;
            const room = this.rooms.get(roomCode);
            
            if (!room) {
                return res.status(404).json({ error: 'Room not found' });
            }
            
            const song = room.playlist.find(s => s._id === songId);
            if (!song || !song.filePath) {
                return res.status(404).json({ error: 'Song not found or not available for streaming' });
            }
            
            // Serve the actual uploaded file
            const filePath = path.join(this.uploadsDir, song.filename);
            
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: 'File not found on server' });
            }
            
            // Set proper headers for audio streaming
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            
            // Stream the file
            const stream = fs.createReadStream(filePath);
            stream.pipe(res);
        });
        
        this.server = http.createServer(this.app);
        this.io = new Server(this.server, {
            cors: {
                origin: "*",
                methods: ["GET", "POST"]
            },
            allowEIO3: true,
            transports: ['websocket', 'polling']
        });
        
        this.setupSocketHandlers();
    }
    
    start() {
        this.server.listen(this.port, () => {
            console.log(`Public Music Room Server running on port ${this.port}`);
            console.log(`Health check: http://localhost:${this.port}/health`);
        });
    }
    
    generateRoomCode() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let code;
        do {
            code = '';
            for (let i = 0; i < 6; i++) {
                code += chars.charAt(Math.floor(Math.random() * chars.length));
            }
        } while (this.roomCodes.has(code));
        
        this.roomCodes.add(code);
        return code;
    }
    
    setupSocketHandlers() {
        this.io.on('connection', (socket) => {
            console.log(`User connected: ${socket.id} from ${socket.handshake.address}`);
            
            // Join room
            socket.on('join-room', (data) => {
                const { roomCode, displayName } = data;
                const room = this.rooms.get(roomCode);
                
                if (!room) {
                    socket.emit('join-error', { message: 'Room not found' });
                    return;
                }
                
                // Add user to room
                const userData = {
                    id: socket.id,
                    displayName: displayName || 'Anonymous',
                    isHost: false,
                    socketId: socket.id,
                    ip: socket.handshake.address
                };
                
                room.participants.set(socket.id, userData);
                this.userSockets.set(socket.id, { roomCode, ...userData });
                
                socket.join(roomCode);
                
                // Update room data
                room.participantCount = room.participants.size;
                
                // Notify room of new participant
                this.io.to(roomCode).emit('participant-joined', {
                    participant: userData,
                    participantCount: room.participantCount
                });
                
                // Send room data to new participant
                socket.emit('room-joined', {
                    room: {
                        code: room.code,
                        name: room.name,
                        description: room.description,
                        playlist: room.playlist,
                        settings: room.settings,
                        participants: Array.from(room.participants.values())
                    },
                    user: userData
                });
                
                console.log(`User ${displayName} joined room ${roomCode} from ${socket.handshake.address}`);
            });
            
            // Create room
            socket.on('create-room', (data) => {
                const { name, description, initialPlaylist } = data;
                const roomCode = this.generateRoomCode();
                
                const room = {
                    code: roomCode,
                    name: name || 'Music Room',
                    description: description || '',
                    playlist: initialPlaylist || [],
                    settings: {
                        playbackMode: 'individual',
                        syncControl: 'host-only'
                    },
                    participants: new Map(),
                    participantCount: 1,
                    createdAt: new Date(),
                    hostId: socket.id,
                    hostIP: socket.handshake.address
                };
                
                // Add host to room
                const hostData = {
                    id: socket.id,
                    displayName: 'Host',
                    isHost: true,
                    socketId: socket.id,
                    ip: socket.handshake.address
                };
                
                room.participants.set(socket.id, hostData);
                this.userSockets.set(socket.id, { roomCode, ...hostData });
                
                this.rooms.set(roomCode, room);
                socket.join(roomCode);
                
                // Send room data to host
                socket.emit('room-created', {
                    room: {
                        code: room.code,
                        name: room.name,
                        description: room.description,
                        playlist: room.playlist,
                        settings: room.settings,
                        participants: Array.from(room.participants.values())
                    },
                    user: hostData
                });
                
                console.log(`Room created: ${roomCode} by ${socket.id} from ${socket.handshake.address}`);
            });
            
            // Update room settings
            socket.on('update-room-settings', (data) => {
                const { roomCode, settings } = data;
                const room = this.rooms.get(roomCode);
                const user = this.userSockets.get(socket.id);
                
                if (!room || !user || !user.isHost) {
                    socket.emit('error', { message: 'Unauthorized to update room settings' });
                    return;
                }
                
                room.settings = { ...room.settings, ...settings };
                
                // Notify all participants of settings change
                this.io.to(roomCode).emit('room-settings-updated', {
                    settings: room.settings
                });
            });
            
                    // Add songs to room playlist
        socket.on('add-to-room-playlist', (data) => {
            const { roomCode, songs } = data;
            const room = this.rooms.get(roomCode);
            const user = this.userSockets.get(socket.id);
            
            if (!room || !user) {
                socket.emit('error', { message: 'Room not found or user not in room' });
                return;
            }
            
            // Add songs to room playlist
            const newSongs = songs.filter(song => 
                !room.playlist.some(existing => existing._id === song._id)
            );
            
            room.playlist.push(...newSongs);
            
            // Notify all participants of playlist update
            this.io.to(roomCode).emit('room-playlist-updated', {
                playlist: room.playlist,
                addedBy: user.displayName
            });
        });
            
            // Remove songs from room playlist
            socket.on('remove-from-room-playlist', (data) => {
                const { roomCode, songIds } = data;
                const room = this.rooms.get(roomCode);
                const user = this.userSockets.get(socket.id);
                
                if (!room || !user) {
                    socket.emit('error', { message: 'Room not found or user not in room' });
                    return;
                }
                
                            // Remove songs from room playlist
            room.playlist = room.playlist.filter(song => !songIds.includes(song._id));
                
                // Notify all participants of playlist update
                this.io.to(roomCode).emit('room-playlist-updated', {
                    playlist: room.playlist,
                    removedBy: user.displayName
                });
            });
            
            // Sync playback control
            socket.on('sync-playback', (data) => {
                const { roomCode, action, songId, currentTime, isPlaying } = data;
                const room = this.rooms.get(roomCode);
                const user = this.userSockets.get(socket.id);
                
                if (!room || !user) {
                    socket.emit('error', { message: 'Room not found or user not in room' });
                    return;
                }
                
                // Check if user can control sync playback
                if (room.settings.playbackMode === 'sync') {
                    if (room.settings.syncControl === 'host-only' && !user.isHost) {
                        socket.emit('error', { message: 'Only host can control synchronized playback' });
                        return;
                    }
                    
                    // Broadcast sync command to all participants
                    socket.to(roomCode).emit('sync-playback-command', {
                        action,
                        songId,
                        currentTime,
                        isPlaying,
                        controlledBy: user.displayName
                    });
                }
            });
            
            // Chat message
            socket.on('chat-message', (data) => {
                const { roomCode, message } = data;
                const room = this.rooms.get(roomCode);
                const user = this.userSockets.get(socket.id);
                
                if (!room || !user) {
                    socket.emit('error', { message: 'Room not found or user not in room' });
                    return;
                }
                
                // Broadcast message to all participants
                this.io.to(roomCode).emit('chat-message', {
                    user: user.displayName,
                    message,
                    timestamp: new Date()
                });
            });
            
            // Disconnect handling
            socket.on('disconnect', () => {
                const user = this.userSockets.get(socket.id);
                
                if (user) {
                    const room = this.rooms.get(user.roomCode);
                    
                    if (room) {
                        // Remove user from room
                        room.participants.delete(socket.id);
                        room.participantCount = room.participants.size;
                        
                        // If host left, close the room
                        if (user.isHost) {
                            this.io.to(user.roomCode).emit('room-closed', {
                                message: 'Host has left the room'
                            });
                            
                            // Remove room
                            this.rooms.delete(user.roomCode);
                            this.roomCodes.delete(user.roomCode);
                            
                            console.log(`Room ${user.roomCode} closed by host`);
                        } else {
                            // Notify remaining participants
                            this.io.to(user.roomCode).emit('participant-left', {
                                participantId: socket.id,
                                participantCount: room.participantCount
                            });
                        }
                    }
                    
                    this.userSockets.delete(socket.id);
                }
                
                console.log(`User disconnected: ${socket.id}`);
            });
        });
    }
    
    getRoomStats() {
        return {
            totalRooms: this.rooms.size,
            totalUsers: this.userSockets.size,
            rooms: Array.from(this.rooms.keys())
        };
    }
    
    stop() {
        this.server.close();
        console.log('Public Music Room Server stopped');
    }
}

// Start server if this file is run directly
if (require.main === module) {
    const server = new PublicMusicRoomServer();
    server.start();
}

module.exports = PublicMusicRoomServer;
