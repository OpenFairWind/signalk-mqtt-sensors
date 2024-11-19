const mqtt = require('mqtt');

const client = mqtt.connect('mqtt://broker.hivemq.com');

client.on('connect', () => {
    console.log('Connected to MQTT broker');
    client.subscribe('test/topic', (err) => {
        if (!err) {
            client.publish('test/topic', 'Hello MQTT');
        }
    });
});

client.on('message', (topic, message) => {
    console.log(`Received message: ${message.toString()} on topic: ${topic}`);
});