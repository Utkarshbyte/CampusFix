CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    summary TEXT,
    category TEXT,
    dept TEXT,
    severity INT,
    safety BOOLEAN,
    location TEXT,
    room TEXT,
    reports INT DEFAULT 1,
    status TEXT DEFAULT 'Reported',
    "createdAt" BIGINT,
    "resolvedAt" BIGINT,
    photo TEXT,
    description TEXT
);
