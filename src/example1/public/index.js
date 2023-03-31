const io = require('socket.io-client');
const mediasoupClient = require('mediasoup-client');
const socket = io('/mediasoup');

let params = {
    // mediasoup params,
    encodings   :
    [
      { rid: 'r0', maxBitrate: 100000, scalabilityMode: 'S1T3' },
      { rid: 'r1', maxBitrate: 300000, scalabilityMode: 'S1T3' },
      { rid: 'r2', maxBitrate: 900000, scalabilityMode: 'S1T3' },
    ],
    codecOptions :
    {
      videoGoogleStartBitrate : 1000
    }
};
let device;
let producer;
let consumer;
let rtpCapabilities;
let producerTransport;
let consumerTransport;
let isProducer = false;

socket.on('connection-success', ({ socketId, existsProducer }) => {
    console.log(socketId, existsProducer);
})

const streamSuccess = (stream) => {
    console.log(stream);
    localVideo.srcObject = stream;
    const track = stream.getVideoTracks()[0];
    params = {
        track,
        ...params
    }
    console.log(params);

    goConnect(true);
}

const goConnect = (isClientProducer) => {
    isProducer = isClientProducer;
    device === undefined ? getRtpCapabilities() : createRecvTransport();
}


const goCreateTransport = () => {
    if (isProducer)
        createSendTransport();
    else
        createRecvTransport();
}

const goConsume = () => {
    goConnect(false);
}

const createDevice = async () => {
    try {
        device = new mediasoupClient.Device();

        await device.load({
            routerRtpCapabilities: rtpCapabilities
        })

        console.log('RTP Capabilities', device.rtpCapabilities);

        // once the device loads, create transport
        goCreateTransport();
    } catch (error) {
        if (error.name === 'UnsupportedError')
            console.warn('browser not supported');
    }
}

/** ------------------------------------------ Event Handlers ------------------------------------------ */

const getLocalStream = (event) => {
    navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
            width: {
                min: 640,
                max: 1920
            },
            height: {
                min: 400,
                max: 1080
            }
        }
    })
    .then(streamSuccess)
    .catch(error => console.log(error));
}

const getRtpCapabilities = () => {
    socket.emit('createRoom', (data) => {
        console.log(`Router RTP Capabilities... ${data.rtpCapabilities}`)

        rtpCapabilities = data.rtpCapabilities;

        // after we get the rtp capabilities from the router, create device

        createDevice();
    });
};


const createSendTransport = () => {
    socket.emit('createWebRtcTransport', { sender: true }, ({ params }) => {
        if (params.error) {
            console.error(params.error);
            return
        }

        console.log(params);
        producerTransport = device.createSendTransport(params);

        producerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
            // Signal local DTLS parameters to the server side transport.
            try {
                await socket.emit(
                    "transport-connect",
                    {
                        dtlsParameters
                    }
                );

                // Tell the transport that parameters were transmitted.
                callback();
            } catch (error) {
                // Tell the transport that something was wrong.
                errback(error);
            }
        });

        producerTransport.on("produce", async (parameters, callback, errback) => {
            // Signal parameters to the server side transport and retrieve the id of 
            // the server side new producer.
            console.log(parameters);

            try {
                await socket.emit(
                    "transport-produce",
                    {
                        kind: parameters.kind,
                        rtpParameters: parameters.rtpParameters,
                        appData: parameters.appData
                    }, ({ id }) => {
                        // Tell the transport that parameters were transmitted and provide it with the
                        // server side producer's id.
                        callback({ id });
                    }
                );
            }
            catch (error) {
                // Tell the transport that something was wrong.
                errback(error);
            }
        })

        connectSendTransport();
    })
}

const connectSendTransport = async () => {
    console.log(params);
    producer = await producerTransport.produce(params);

    producer.on('track-end', () => {
        console.log('track ended');

        // close video track
    })

    producer.on('transportclose', () => {
        console.log('transport ended');

        // close video track
    })
}

const createRecvTransport = async () => {
    socket.emit('createWebRtcTransport', { sender: false }, ({ params }) => {
        if (params.error) {
            console.error("ERROR:", params.error);
            return
        }

        console.log(params);

        // create client-side recv transport
        consumerTransport = device.createRecvTransport(params);

        consumerTransport.on("connect", async ( { dtlsParameters }, callback, errback) => {
            // Signal local DTLS parameters to the server side transport.
            try {
                await socket.emit(
                    "transport-recv-connect",
                    {
                        //transportId: consumerTransport.id,
                        dtlsParameters
                    }
                );

                // Tell the transport that parameters were transmitted.
                callback();
            } catch (error) {
                // Tell the transport that something was wrong.
                errback(error);
            }
        })

        connectRecvTransport();
    })
}

const connectRecvTransport = async () => {
    await socket.emit('consume', {
        rtpCapabilities: device.rtpCapabilities,
    }, async ({ params }) => {
        if (params.error) {
            console.error('Cannot consume, Reason: ', params.error);
            return;
        }

        console.log("consumer params", params)
        consumer = await consumerTransport.consume({
            id: params.id,
            producerId: params.producerId,
            kind: params.kind,
            rtpParameters: params.rtpParameters
        });

        // Render the remote video track into a HTML video element.
        const { track } = consumer;

        remoteVideo.srcObject = new MediaStream([ track ]);

        socket.emit('consumer-resume');
    })
}

btnLocalVideo.addEventListener('click', getLocalStream);
btnRecvSendTransport.addEventListener('click', goConsume);