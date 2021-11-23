const fs = require("fs")
const path = require("path")
const { promisify } = require('util')

// TODO move these helper functions into a seperate file

let getFiles = async function(dir) {
    const readdir = promisify(fs.readdir)
    const stat    = promisify(fs.stat)
    const subdirs = await readdir(dir)
    const files   = await Promise.all(
        subdirs.map(async subdir => {
            const res = path.resolve(dir, subdir)
            return (await stat(res)).isDirectory() ? getFiles(res) : res
        })
    )
    return files.reduce((a, f) => a.concat(f), [])
}

let absolutePath = function(relativeLocation) {
    return path.join(process.cwd(), relativeLocation)
}

let set = function(obj, attributeList, value) {
    // convert string values into lists
    if (typeof attributeList == 'string') {
        attributeList = attributeList.split('.')
    }
    if (attributeList instanceof Array) {
        try {
            var lastAttribute = attributeList.pop()
            for (var elem of attributeList) {
                // create each parent if it doesnt exist
                if (!(obj[elem] instanceof Object)) {
                    obj[elem] = {}
                }
                // change the object reference be the nested element
                obj = obj[elem]
            }
            obj[lastAttribute] = value
        } catch (error) {
            console.warn("the set function was unable to set the value for some reason, here is the original error message",error)
            console.warn(`the set obj was:`,obj)
            console.warn(`the set attributeList was:`,attributeList)
            console.warn(`the set value was:`,value)
        }
    } else {
        console.log(`obj is:`,obj)
        console.log(`attributeList is:`,attributeList)
        console.log(`value is:`,value)
        console.error(`There is a 'set' function somewhere being called and its second argument isn't a string or a list (see values above)`);
    }
}

let backendFunctions
module.exports = {
    frontendSideEffects : `
        Creates a connection to server using socket.io 
        Uses window.io
        Uses window.socket
        Uses quik.backend
    `,
    backendSideEffects : `
        Creates a socket.io connection with the app.server
        Exposes all files functions that match the automaticBackendImporter() function 
        Attaches the listener "backend" on the socket
        uses app.settings.automaticBackendImporter 
    `,
    generateFrontend : async (app) => {
        // set default settings if not set
        if (!app.settings.automaticBackendImporter) {
            // automatically import any backend function named ".backend.js"
            app.settings.automaticBackendImporter = (fileName) => fileName.match(/\.backend\.js$/)
        }

        // 
        // Extract all the functions from the backend
        // 
        backendFunctions = {}
        let backendObjectForFrontend = {}
        let listOfFiles = await getFiles(absolutePath(app.settings.codeFolder))
        for (let each of listOfFiles) {
            // if the function returns truthy
            if (app.settings.automaticBackendImporter(each)) {
                // then import the file
                let importedModule = require(each);
                // if its a function then include it
                if (importedModule instanceof Function) {
                    // convert "/_Programming/quik-app/code/tryme.backend.js"
                    // into "code/tryme" then into just "tryme"
                    let simplePath = (path.relative(process.cwd(), each)).replace(/(\.backend|)\.js/,"");
                    let findCodeFolder = new RegExp(`\^${app.settings.codeFolder}/`, 'i');
                    simplePath = ("./"+simplePath).replace(findCodeFolder, "")
                    let keyList = simplePath.split("/")
                    set(backendObjectForFrontend, keyList, simplePath)
                    backendFunctions[simplePath] = importedModule;
                }
            }
        }
        return `
            // setup of the "backend" object
            quik.backend = ${JSON.stringify(backendObjectForFrontend)}
            window.io = require("socket.io-client")
            window.socket = new io.connect("/", {
                'reconnection': false
            })
            // a helper for setting nested values 
            function set(obj, attributeList, value) {
                if (attributeList instanceof Array) {
                    try {
                        var lastAttribute = attributeList.pop()
                        for (var elem of attributeList) {
                            // create each parent if it doesnt exist
                            if (!(obj[elem] instanceof Object)) {
                                obj[elem] = {}
                            }
                            // change the object reference be the nested element
                            obj = obj[elem]
                        }
                        obj[lastAttribute] = value
                    } catch (error) {
                    }
                }
            }
            // a helper for getting nested values 
            var get = (obj, keyList) => {
                for (var each of keyList) {
                    try { obj = obj[each] }
                    catch (e) { return null }
                }
                return obj == null ? null : obj
            }
            // a helper for ... well ..recursively getting All Attributes Of an object
            var recursivelyAllAttributesOf = (obj) => {
                // if not an object then add no attributes
                if (!(obj instanceof Object)) {
                    return []
                }
                // else check all keys for sub-attributes
                var output = []
                for (let eachKey of Object.keys(obj)) {
                    // add the key itself (alone)
                    output.push([eachKey])
                    // add all of its children
                    let newAttributes = recursivelyAllAttributesOf(obj[eachKey])
                    // if nested
                    for (let eachNewAttributeList of newAttributes) {
                        // add the parent key
                        eachNewAttributeList.unshift(eachKey)
                        output.push(eachNewAttributeList)
                    }
                }
                return output
            }
            let callCounter = BigInt(0)
            const callBackend = (functionPath, args) => {
                console.debug('functionPath is:',functionPath)
                console.debug('args is:',args)
                // increment the counter
                callCounter += BigInt(1)
                const callCounterAsString = \`\${callCounter}\`
                socket.emit("backend", { functionPath, callCounter: callCounterAsString, args })
                return new Promise((resolve, reject) => {
                    socket.on("backendResponse:"+callCounterAsString, response => resolve(response))
                    socket.on("backendError:"+callCounterAsString   , response => reject(response))
                })
            }
            let createBackendCaller = (backendPath) => (...args) => callBackend(backendPath, args)

            for (const each of recursivelyAllAttributesOf(quik.backend)) {
                const value = get(quik.backend, each)
                if (value instanceof Object) {
                    continue
                }
                // convert it from a string into a function
                set(quik.backend, each, createBackendCaller(value))
            }
        `
    },
    afterBundlerSetup : (app) => {
        const socketIo = require('socket.io')
        app.io = socketIo(app.server, { origins: '*:*' })
        app.io.on('connection', (socket) => {
            // setup a listener for the function
            socket.on("backend", async ({ functionPath, callCounter, args }) => {
                try {
                    // send the output right back to the client
                    socket.emit(`backendResponse:${callCounter}`, await backendFunctions[functionPath](...args))
                } catch (error) {
                    // if there was an error, tell the frontend about it 
                    socket.emit(`backendError:${callCounter}`, error)
                }
            })
        })
    },
}