/*
 * Copyright 2024 Ryan Gregg (ryan@ryangregg.com).
 * Licensed under Apache 2 license. See LICENSE for more information.
 */

const app_name = "signalk-mqtt-sensors";
const mqtt = require('mqtt');
const jsonpath = require('jsonpath')
const crypto = require('crypto');

console.log(`loading ${app_name}`);

const SensorType = Object.freeze({
    TEMPERATURE: "temperature",
    WATER_LEAK: "water_leak",
    HUMIDITY: "humidity",
    BATTERY: "battery",
    PRESSURE: "pressure",
    OTHER: "other"
});

module.exports = function(app) {
    var plugin = {};

    plugin.id = app_name;
    plugin.name = "MQTT Sensors"
    plugin.description = "Signal K node server plugin for mapping values between MQTT and Signal K topics";

    // define the option schema for the add-on
    plugin.schema =  require("./schema.json")
    plugin.uiSchema = require("./uischema.json")

    plugin.mqttClient = null;

    // start method when the plugin is started. Options will
    // match the schema specified in the schema provided above.
    plugin.start = function(options, restartPluginFunc) {
        console.log(`Staring ${app_name}`);
        
        const fromTopics = loadFromTopics(options);
        const toTopics = loadToTopics(options);

        app.debug("Updating server with SignalK metadata units");
        publishDataTypesToServer(app, fromTopics);

        // Connect to the MQTT server and start listening for changes
        // to the topics we're interested in
                
        if (options.enabled)
        {
            app.debug("Connecting to MQTT server...");
            plugin.mqttConnection = connectToMqttServer(options, fromTopics);

            if (toTopics.enabled) {
                app.debug("Connecting to SignalK deltas...");
                subscribeToDeltas(app, toTopics, plugin.mqttConnection);
            }
        }

        function subscribeToDeltas(app, toTopics, mqttClient) {
            const homeAssistantDiscoveryEnabled = toTopics.home_assistant_discovery | false;
            const lastPublishedTimestamps = new Map(); // Store the last published timestamps for each path
            const rateLimit = (typeof toTopics.min_publish_interval === 'number' ? toTopics.min_publish_interval : 0) * 1000;
            const baseTopic = toTopics.base_topic;
            toTopics.paths.forEach(path => {
                app.streambundle.getSelfStream(path).onValue(value => {
                    //app.debug(`Delta received for ${path}:`, value);
            
                    const currentTime = Date.now();
                    const lastPublishedTime = lastPublishedTimestamps.get(path) || 0;

                    if (homeAssistantDiscoveryEnabled) 
                    {
                        // The first time we encounter a value - register it with Home Assistant
                        publishHomeAssistantDiscovery(app, mqttClient, toTopics.base_topic, path);
                    }
            
                    // Check if enough time has elapsed since the last update
                    if ((currentTime - lastPublishedTime) >= rateLimit) {
                        publishDeltaToMqtt(mqttClient, baseTopic, path, value);
                        lastPublishedTimestamps.set(path, currentTime); // Update the last published timestamp
                    } else {
                        //app.debug(`Skipping update for ${path}: Minimum time interval not reached.`);
                    }
                });
            
                // Publish the current value to MQTT when starting (rate limit is not applied here)
                const value = app.getSelfPath(path);
                if (value !== undefined) {
                    publishDeltaToMqtt(mqttClient, baseTopic, path, value);
                    lastPublishedTimestamps.set(path, Date.now()); // Initialize the last published timestamp
                }
            })
        }

        function publishDeltaToMqtt(mqttClient, baseTopic, path, value) {
            if (!mqttClient) {
                app.debug("MQTT client is not connected, cannot publish.");
                return;
            }

            const topic = `${baseTopic}/${path}`;
        
            const payload = JSON.stringify({
                path: path,
                value: value
            });
        
            mqttClient.publish(topic, payload, { qos: 1 }, (err) => {
                if (err) {
                    app.debug(`Error publishing to topic ${topic}:`, err.message);
                } else {
                    app.debug(`Published to topic ${topic}: ${payload}`);
                }
            });
        }

        function connectToMqttServer(options, fromTopics) {
            const client_options = {
                username: options.mqtt_username,
                password: options.mqtt_password
            };
    
            const mqttClient = mqtt.connect(options.mqtt_server, client_options);
            mqttClient.on('connect', () => {
                console.log(`Connected to MQTT broker: ${options.mqtt_server}`);
                setStatus(`Connected to ${options.mqtt_server}`, false);

                // list topics to subscribe to
                const topics = identifyTopicsForSubscription(fromTopics);
                app.debug("MQTT topics for subscription", topics)

                mqttClient.subscribe(topics, (err) => {
                    if (err) {
                        console.warn(`Error subscribing to topics: ${err}`);
                    }

                    else {
                        app.debug("Subscribed to all required topics");
                    }
                });
            });

            // Event: Disconnected
            mqttClient.on('disconnect', (packet) => {
                console.warn('MQTT client disconnected:', packet);
                setStatus("Disconnected", false);
            });

            // Event: Reconnect attempt
            mqttClient.on('reconnect', () => {
                console.log('Attempting to reconnect to MQTT broker...');
                setStatus("Attemping to reconnect to MQTT broker...", false);
            });

            // Event: Connection closed
            mqttClient.on('close', () => {
                console.log('MQTT connection closed');
                setStatus("Connect closed.", false);
            });

            // Event: Error
            mqttClient.on('error', (err) => {
                console.error('MQTT error:', err.message);
                // Handle critical errors here if needed
                setStatus(`Connection error: ${err.message}`, true);
                restartPluginFunc();
            });

            // Event: Message received
            mqttClient.on('message', (topic, message) => {
                app.debug(`Received MQTT message: ${message.toString()} on topic: ${topic}`);

                let deltas = processMqttMessage(topic, message.toString());
                const data = {
                    updates: [
                      {
                        values: deltas
                      }
                    ]
                };

                if (data) {
                    app.debug("Updating app with deltas: ", data)
                    app.handleMessage(plugin.id, data);
                }
            });

            return mqttClient;
        }

        function getTopic(fromTopics, search) {
            for (const topic of fromTopics) {
                if (topic.mqtt_topic === search) {
                    return topic; // This returns the topic and exits the function
                }
            }
            return null; // Return null if no match is found
        }

        function processMqttMessage(topic, value) {
            const config = getTopic(fromTopics, topic)
            if (null == config)
            {
                app.debug("Couldn't find a registration for MQTT topic", topic);
                return;
            }

            app.debug("Processing topic", topic)

            let deltas = [];
            config.sensors.forEach(sensor => {
                // Parse the sensor to see if we have the data we need for it
                let parsedValue = value;
                app.debug("Parsing value", value);
                
                if (sensor.json_path != null) {
                    // Parse the response as JSON and retrive the value from the path
                    try
                    {
                        const jsonObject = JSON.parse(value);
                        const result = jsonpath.query(jsonObject, sensor.json_path);
                        if (result && result.length > 0) {
                            parsedValue = result[0];
                            app.debug(`Parsed ${sensor.json_path} to find value ${parsedValue}`);
                        } else {
                            app.debug(`JSON path ${sensor.json_path} did not return any results.`);
                            return; // Skip this sensor if no value is found
                        }
                    } catch (error) {
                        app.debug("Error finding value from JSON path", error)
                        return;
                    }
                }
                const delta = prepareDelta(sensor, parsedValue);
                deltas.push(delta);
            });

            app.debug("Found deltas: ", deltas);
            return deltas;
        }

        function prepareDelta(sensor, parsedValue) {
            // Do any conversions necessary between the input value defined by the sensor
            // parameters and the expected output value for that data type in Signal K.

            const type = sensor.sensor;
            const unit = sensor.unit;
            const signalk_path = sensor.destination;
            let value = null;
            app.debug(`Preparing delta for ${type} with unit ${unit} to path ${signalk_path}`);
            switch(type) {
                case SensorType.TEMPERATURE:
                    if (unit == "F") {
                        // Convert from F to K
                        value = (Number(parsedValue) - 32) / 1.8 + 273.15;
                        value = parseFloat(value.toFixed(2)); // Rounds to 2 decimal points
                        app.debug(`Converting temperature from F to K: ${value}`);
                    } else if (unit == "C") {
                        // Convert from C to K
                        value = Number(parsedValue) + 273.15;
                        value = parseFloat(value.toFixed(2)); // Rounds to 2 decimal points
                        app.debug(`Converting temperature from C to K: ${value}`);                        
                    }
                    else if (unit == "K") {
                        app.debug("No data conversion necessary");
                        value = Number(parsedValue);
                    }
                    break;
                case SensorType.PRESSURE:
                    switch (unit) {
                        case "Pa":
                            app.debug("No data conversion necessary");
                            value = Number(parsedValue);
                            break;
                        case "hPa":
                            app.debug(`Converting pressure from hPa to Pa: ${value}`)
                            value = Number(parsedValue) * 100.0;
                            break;
                        case "mmHg":
                            app.debug(`Converting pressure from mmHg to Pa: ${value}`)
                            value = Number(parsedValue) * 133.322;
                            break;
                        case "atm":
                            app.debug(`Converting pressure from atm to Pa: ${value}`)
                            value = Number(parsedValue) * 101325.0;
                            break;
                        default:
                            app.debug(`Unknown conversion from ${unit} to SI unit for pressure.`);
                            value = parsedValue;
                            break;
                    }
                    break;
                default:
                    app.debug(`No data type conversation for ${type}`);
                    value = parsedValue;
            }
            return {
                path: signalk_path,
                value: value
            }
        }

        // Return an array of strings with the unique values
        // of the mqtt_topics parameter from the objects in the from field
        // in the mqtt-sensors.yaml file
        function identifyTopicsForSubscription(fromTopics) {
            if (!Array.isArray(fromTopics)) {
                throw new Error("Invalid input: fromTopics must be an array");
            }
        
            // Use a Set to ensure uniqueness of topics
            const uniqueTopics = new Set();
        
            fromTopics.forEach((topicObj) => {
                if (topicObj.mqtt_topic) {
                    uniqueTopics.add(topicObj.mqtt_topic);
                }
            });

            // Convert the Set back to an array
            return Array.from(uniqueTopics);
        }
        function getSIUnit(sensorType) {
            switch (sensorType) {
                case SensorType.TEMPERATURE:
                    return "K"; // Kelvin
                case SensorType.HUMIDITY:
                    return "%"; // Percentage
                case SensorType.BATTERY:
                    return "%"; // Percentage
                case SensorType.PRESSURE:
                    return "Pa"; // Pascal
                case SensorType.WATER_LEAK:
                    return "boolean"; // Boolean for presence/absence
                case SensorType.OTHER:
                default:
                    return null; // Or a sensible default like an empty string
            }
        }        

        function publishDataTypesToServer(app, fromTopics) {
            app.debug('Updating data types with server', fromTopics);

            let meta = [];
            fromTopics.forEach(topic => {
                const sensors = topic.sensors;
                sensors.forEach(sensor => {
                    app.debug('Discovering data for sensor', sensor);
                    const path = sensor.destination;
                    var unit = getSIUnit(sensor.sensor);
                    if (unit) {
                        meta.push({
                            path: path,
                            value: { units: unit }
                        });
                    }

                })
            })

            if (meta.length > 0) {
                app.debug('Publishing meta data types', meta)
                app.handleMessage(plugin.id, {
                    updates: [{
                        meta: meta
                    }]
                });
            } else {
                app.debug("No deltas were created for this notification. Nothing updated");
            }
        }

        function loadFromTopics(options) {
            const from = options.from;

            if (!Array.isArray(from))
                return [];

            app.debug("Loading MQTT sensor definitions...")
            from.forEach( (topic) => {
                app.debug("MQTT Topic: ", topic);
                app.debug("  Defined Sensors:");
                topic.sensors.forEach( (sensor) => {
                    app.debug(`${JSON.stringify(sensor)}`)
                });
            });

            return from;
        }

        function loadToTopics(options) {
            const to = options.to;
            if (to == undefined) {
                return { 
                    enabled: false,
                    base_topic: "",
                    paths: []
                };
            }
            
            const paths = to.paths;
            if (!Array.isArray(paths)) {
                return { 
                    enabled: false,
                    base_topic: "",
                    paths: []
                };
            }

            app.debug("Loading export sensors...");
            paths.forEach( (topic) => {
                app.debug(`Export: Path: ${topic.signalk_path} to Topic: ${topic.mqtt_topic}`);
            });
            return to;
        }

        const hasRegisteredWithHomeAssistant = new Map();

        function publishHomeAssistantDiscovery(app, mqttClient, baseTopic, path) {
            
            const isRegistered = hasRegisteredWithHomeAssistant.get(path);
            if (isRegistered) {
                return;
            }

            app.debug("Home Assistant: generating discovery for path", path);
            const metadata = app.getSelfPath(path + ".meta");
            if (metadata == undefined) {
                app.debug(`Path ${path} is not defined in Signal K - skipped.`);
                return;
            }

            hasRegisteredWithHomeAssistant.set(path, path);
            app.debug("Signal K Data for", path, metadata);

            const configPayload = {
                device: {
                    identifiers: [ "41c0ad04-4bcd-425a-b749-8bf4554d4cf4" ],
                    manufacturer: "rgregg",
                    model: "signalk-mqtt-sensors",
                    name: "Signal K MQTT Sensors",
                    sw_version: "1.1.1"
                },
                name: metadata.displayName || convertPathToDisplayName(path),  // Convert from Signal K path to friendly name
                state_class: "measurement",
                device_class: determineDeviceClass(metadata),
                unit_of_measurement: metadata.units,
                unique_id: generateUUIDFromPath(path),              // Hash of the Signal K path & device ID
                state_topic: `${baseTopic}/${path}`,
                value_template: "{{ value_json.value }}"
            };

            app.debug("Registering HA entity for path: ", configPayload);
            
            // Publish the discovery message to the correct topic
            const component = "sensor"; // Change this based on the type of device (e.g., binary_sensor)
            const objectId = configPayload.unique_id;
            const discoveryTopic = `homeassistant/${component}/${objectId}/config`;

            mqttClient.publish(
                discoveryTopic,
                JSON.stringify(configPayload),
                { retain: true, qos: 1 },
                (err) => {
                    if (err) {
                        app.debug(`Failed to publish HA discovery config for ${path}: ${err.message}`);
                    } else {
                        app.debug(`Published HA discovery config for ${path} to ${discoveryTopic}`);
                    }
                }
            );
            app.debug("Discovery enabled for path", path);
        }

        function determineDeviceClass(metadata) {
            if (!metadata) {
                app.debug("No metadata was available to determine device class");
                return ""; // Default if metadata is unavailable
            }
        
            const unit = metadata.units?.toLowerCase();
            const displayName = metadata.displayName?.toLowerCase();
            const path = metadata.path?.toLowerCase();
        
            // Map units to device_class
            if (unit === "v") return "voltage";
            if (unit === "a") return "current";
            if (unit === "%") {
                if (path.includes("humidity")) return "humidity";
                if (path.includes("battery")) return "battery";
            }
            if (unit === "k" || unit === "°c" || unit === "°f") return "temperature";
            if (["pa", "hpa", "atm"].includes(unit)) return "pressure";
            if (unit === "boolean") {
                if (path.includes("water") || displayName.includes("leak")) return "moisture";
                return "problem";
            }
        
            // Fallback for other cases based on path or displayName
            if (path.includes("voltage")) return "voltage";
            if (path.includes("amperage") || path.includes("current")) return "current";
            if (path.includes("temperature")) return "temperature";
        
            app.debug(`No device_class was determined for data ${displayName}`);
            return ""; // Default if no match is found
        }

        /**
         * Converts a Signal K path to a display name.
         * @param {string} path - The Signal K path (e.g., "electrical.batteries.house.voltage").
         * @returns {string} - The human-readable display name (e.g., "Electrical Batteries House Voltage").
         */
        function convertPathToDisplayName(path) {
            if (!path || typeof path !== "string") {
                throw new Error("Invalid path: Path must be a non-empty string.");
            }

            // Split the path into components using the '.' delimiter
            const components = path.split('.');

            // Capitalize the first letter of each component and join them with spaces
            const displayName = components
                .map(component => component.charAt(0).toUpperCase() + component.slice(1))
                .join(' ');

            return displayName;
        }

        /**
         * Generates a UUID based on the hash of the input string.
         * @param {string} input - The input string to hash (e.g., a Signal K path).
         * @returns {string} - The generated UUID.
         */
        function generateUUIDFromPath(input) {
            if (!input || typeof input !== "string") {
                throw new Error("Invalid input: must be a non-empty string.");
            }

            // Hash the input string using SHA-1
            const hash = crypto.createHash('sha1').update(input).digest('hex');

            // Format the hash into a UUID
            const uuid = [
                hash.slice(0, 8),        // 8 characters
                hash.slice(8, 12),       // 4 characters
                `4${hash.slice(13, 16)}`, // 4 characters, 4 indicates version 4 UUID
                `${(parseInt(hash[16], 16) & 0x3 | 0x8).toString(16)}${hash.slice(17, 20)}`, // 4 characters
                hash.slice(20, 32)       // 12 characters
            ].join('-');

            return uuid;
        }
    }

    plugin.stop = function() {
        app.debug(`${app_name} is stopping`);
        if (plugin.mqttClient) {
            plugin.mqttClient.end()
            plugin.mqttClient = null;
        }
    }

    function setStatus(statusMessage, isError) {
        if (isError) {
            app.setPluginError(statusMessage)
            app.debug(`Error: ${statusMessage}`);
        } else {
            app.setPluginStatus(statusMessage);
        }
    }

    return plugin;
}
