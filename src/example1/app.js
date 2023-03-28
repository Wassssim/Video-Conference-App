"use strict";

import express from 'express';
const app = express();

import https from 'httpolyglot';
import fs from 'fs';
import path from 'path';
const __dirname = path.resolve();

import { Server } from 'socket.io';

import mediasoup from 'mediasoup';

app.get('/', (req, res) => {
    res.send("Hello");
});

app.use('/sfu', express.static(path.join(__dirname, 'public')));

const options = {
    key: fs.readFileSync('./server/ssl/key.pem', 'utf-8'),
    cert: fs.readFileSync('./server/ssl/cert.pem', 'utf-8')
};

const httpServer = https.createServer(options, app);

httpServer.listen(3000, () => {
    console.log('listening on port: ' + 3000);
});

const io = new Server(httpServer);
const peers = io.of('/mediasoup');


let worker;
let router;
let producerTransport;
let consumerTransport;
let producer;
let consumer;

const createWorker = async () => {
    worker = await mediasoup.createWorker({
        rtcMinPort: 2000,
        rtcMaxPort: 2020
    });

    console.log(`worker pid ${worker.pid}`);

    worker.on('died', error => {
        console.error('mediasoup worker has died');
        setTimeout(() => process.exit(1), 2000); // exit in 2 seconds
    })

    return worker;
}

worker = createWorker();

const mediaCodecs = [
    {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2
    },
    {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
            'x-google-start-bitrate': 1000,

        }
    }
]

peers.on('connection', async socket => {
    console.log(socket.id);
    socket.emit('connection-success', {
        socketId: socket.id
    });

    router = await worker.createRouter({ mediaCodecs });

    socket.on('disconnect', () => {
        // cleanup
        console.log('peer disconnected');
    });

    socket.on('getRtpCapabilities', (callback) => {
        const rtpCapabilities = router.rtpCapabilities;
        console.log('rtp Capabilities', rtpCapabilities);

        callback({rtpCapabilities});
    })

    socket.on('createWebRtcTransport', async ({ sender }, callback ) => {
        console.log(`Is this a sender request? ${sender}`)

        if (sender)
            producerTransport = await createWebRtcTransport(callback);
        else
            consumerTransport = await createWebRtcTransport(callback);
    })

    socket.on('transport-connect', async ({ dtlsParameters }) => {
        console.log('DTLS PARAMS...', dtlsParameters);

        await producerTransport.connect({ dtlsParameters });
    });

    socket.on('transport-produce', async ({kind, rtpParameters, appData}, callback) => {
        producer = await producerTransport.produce({
            kind,
            rtpParameters,
        });

        console.log('Producer ID: ', producer.id, producer.kind);

        producer.on(('transportclose'), () => {
            console.log('transport for this producer closed');
            producer.close();
        })

        callback({
            id: producer.id
        })
    })

    
    socket.on("transport-recv-connect", async ({ dtlsParameters }) => {
        console.log('DTLS PARAMS...', dtlsParameters);

        await consumerTransport.connect({ dtlsParameters });
    });

    socket.on("consume", async ({ rtpCapabilities }, callback) => {
        if (!router.canConsume({
            producerId: producer.id,
            rtpCapabilities
        })) {
            console.error("client device cannot consume producer!")
            callback({
                params: {
                    error: "client device cannot consume producer!"
                }
            })
        };

        try {
            consumer = await consumerTransport.consume({
                producerId: producer.id,
                rtpCapabilities,
                paused: true
            });

            consumer.on('transportclose', () => {
                console.log('transport close from consumer')
            });

            consumer.on('producerclose', () => {
                console.log('producer of consumer closed')
            });

            const params = {
                id: consumer.id,
                producerId: consumer.producerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters
            };

            callback({ params });
        } catch (error) {
            console.error(error.message);
            callback({
                params: {
                    error: error.message
                }
            })
        }
    })

    socket.on('consumer-resume', async () => {
        console.log("consumer resume");
        await consumer.resume();
    })
})

const createWebRtcTransport = async (callback) => {
    try {
        const webRtcTransportOptions = {
            listenIps    : [ {
                ip: "0.0.0.0",
                announcedIp: '192.168.1.25'
            } ],
            enableUdp    : true,
            enableTcp    : true,
            preferUdp    : true
        };

        const transport = await router.createWebRtcTransport(webRtcTransportOptions);

        console.log("Transport ID: ", transport.id);

        transport.on('dtlsstatechange', dtlsState => {
            if (dtlsState === "closed")
                transport.close();
        });

        callback({
            params: {
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            }
        });

        return transport;
    } catch (error) {
        console.log(error);
        callback({
            params: {
                error
            }
        })
    }
}