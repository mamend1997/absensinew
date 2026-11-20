import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import attendanceRouter from './routes/attendance.js';
import authRouter from './routes/auth.js';
import classroomsRouter from './routes/classrooms.js';
import participantsRouter from './routes/participants.js';
import settingsRouter from './routes/settings.js';

export const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin: config.webOrigin.split(',').map((origin) => origin.trim()),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_request, response) => response.json({ status: 'ok' }));
app.use('/api/auth', authRouter);
app.use('/api/kelas', classroomsRouter);
app.use('/api/peserta', participantsRouter);
app.use('/api/pengaturan', settingsRouter);
app.use('/api/absensi', attendanceRouter);
app.use(notFoundHandler);
app.use(errorHandler);
