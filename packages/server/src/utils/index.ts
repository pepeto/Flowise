import path from 'path'
import fs from 'fs'
import moment from 'moment'
import {
    IComponentNodes,
    IDepthQueue,
    IExploredNode,
    INodeDependencies,
    INodeDirectedGraph,
    INodeQueue,
    IReactFlowEdge,
    IReactFlowNode,
    IVariableDict,
    INodeData,
    IOverrideConfig
} from '../Interface'
import { cloneDeep, get } from 'lodash'
import { ICommonObject, getInputVariables } from 'flowise-components'
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto'

const QUESTION_VAR_PREFIX = 'question'

/**
 * Returns the home folder path of the user if
 * none can be found it falls back to the current
 * working directory
 *
 */
export const getUserHome = (): string => {
    let variableName = 'HOME'
    if (process.platform === 'win32') {
        variableName = 'USERPROFILE'
    }

    if (process.env[variableName] === undefined) {
        // If for some reason the variable does not exist
        // fall back to current folder
        return process.cwd()
    }
    return process.env[variableName] as string
}

/**
 * Returns the path of node modules package
 * @param {string} packageName
 * @returns {string}
 */
export const getNodeModulesPackagePath = (packageName: string): string => {
    const checkPaths = [
        path.join(__dirname, '..', 'node_modules', packageName),
        path.join(__dirname, '..', '..', 'node_modules', packageName),
        path.join(__dirname, '..', '..', '..', 'node_modules', packageName),
        path.join(__dirname, '..', '..', '..', '..', 'node_modules', packageName),
        path.join(__dirname, '..', '..', '..', '..', '..', 'node_modules', packageName)
    ]
    for (const checkPath of checkPaths) {
        if (fs.existsSync(checkPath)) {
            return checkPath
        }
    }
    return ''
}

/**
 * Construct graph and node dependencies score
 * @param {IReactFlowNode[]} reactFlowNodes
 * @param {IReactFlowEdge[]} reactFlowEdges
 * @param {boolean} isNondirected
 */
export const constructGraphs = (reactFlowNodes: IReactFlowNode[], reactFlowEdges: IReactFlowEdge[], isNondirected = false) => {
    const nodeDependencies = {} as INodeDependencies
    const graph = {} as INodeDirectedGraph

    for (let i = 0; i < reactFlowNodes.length; i += 1) {
        const nodeId = reactFlowNodes[i].id
        nodeDependencies[nodeId] = 0
        graph[nodeId] = []
    }

    for (let i = 0; i < reactFlowEdges.length; i += 1) {
        const source = reactFlowEdges[i].source
        const target = reactFlowEdges[i].target

        if (Object.prototype.hasOwnProperty.call(graph, source)) {
            graph[source].push(target)
        } else {
            graph[source] = [target]
        }

        if (isNondirected) {
            if (Object.prototype.hasOwnProperty.call(graph, target)) {
                graph[target].push(source)
            } else {
                graph[target] = [source]
            }
        }
        nodeDependencies[target] += 1
    }

    return { graph, nodeDependencies }
}

/**
 * Get starting nodes and check if flow is valid
 * @param {INodeDependencies} graph
 * @param {string} endNodeId
 */
export const getStartingNodes = (graph: INodeDirectedGraph, endNodeId: string) => {
    const visited = new Set<string>()
    const queue: Array<[string, number]> = [[endNodeId, 0]]
    const depthQueue: IDepthQueue = {
        [endNodeId]: 0
    }

    let maxDepth = 0
    let startingNodeIds: string[] = []

    while (queue.length > 0) {
        const [currentNode, depth] = queue.shift()!

        if (visited.has(currentNode)) {
            continue
        }

        visited.add(currentNode)

        if (depth > maxDepth) {
            maxDepth = depth
            startingNodeIds = [currentNode]
        } else if (depth === maxDepth) {
            startingNodeIds.push(currentNode)
        }

        for (const neighbor of graph[currentNode]) {
            if (!visited.has(neighbor)) {
                queue.push([neighbor, depth + 1])
                depthQueue[neighbor] = depth + 1
            }
        }
    }

    const depthQueueReversed: IDepthQueue = {}
    for (const nodeId in depthQueue) {
        if (Object.prototype.hasOwnProperty.call(depthQueue, nodeId)) {
            depthQueueReversed[nodeId] = Math.abs(depthQueue[nodeId] - maxDepth)
        }
    }

    return { startingNodeIds, depthQueue: depthQueueReversed }
}

/**
 * Get ending node and check if flow is valid
 * @param {INodeDependencies} nodeDependencies
 * @param {INodeDirectedGraph} graph
 */
export const getEndingNode = (nodeDependencies: INodeDependencies, graph: INodeDirectedGraph) => {
    let endingNodeId = ''
    Object.keys(graph).forEach((nodeId) => {
        if (Object.keys(nodeDependencies).length === 1) {
            endingNodeId = nodeId
        } else if (!graph[nodeId].length && nodeDependencies[nodeId] > 0) {
            endingNodeId = nodeId
        }
    })
    return endingNodeId
}

/**
 * Build langchain from start to end
 * @param {string} startingNodeId
 * @param {IReactFlowNode[]} reactFlowNodes
 * @param {INodeDirectedGraph} graph
 * @param {IDepthQueue} depthQueue
 * @param {IComponentNodes} componentNodes
 * @param {string} question
 */
export const buildLangchain = async (
    startingNodeIds: string[],
    reactFlowNodes: IReactFlowNode[],
    graph: INodeDirectedGraph,
    depthQueue: IDepthQueue,
    componentNodes: IComponentNodes,
    question: string,
    overrideConfig?: ICommonObject
) => {
    const flowNodes = cloneDeep(reactFlowNodes)

    // Create a Queue and add our initial node in it
    const nodeQueue = [] as INodeQueue[]
    const exploredNode = {} as IExploredNode

    // In the case of infinite loop, only max 3 loops will be executed
    const maxLoop = 3

    for (let i = 0; i < startingNodeIds.length; i += 1) {
        nodeQueue.push({ nodeId: startingNodeIds[i], depth: 0 })
        exploredNode[startingNodeIds[i]] = { remainingLoop: maxLoop, lastSeenDepth: 0 }
    }

    while (nodeQueue.length) {
        const { nodeId, depth } = nodeQueue.shift() as INodeQueue

        const reactFlowNode = flowNodes.find((nd) => nd.id === nodeId)
        const nodeIndex = flowNodes.findIndex((nd) => nd.id === nodeId)
        if (!reactFlowNode || reactFlowNode === undefined || nodeIndex < 0) continue

        try {
            const nodeInstanceFilePath = componentNodes[reactFlowNode.data.name].filePath as string
            const nodeModule = await import(nodeInstanceFilePath)
            const newNodeInstance = new nodeModule.nodeClass()

            let flowNodeData = cloneDeep(reactFlowNode.data)
            if (overrideConfig) flowNodeData = replaceInputsWithConfig(flowNodeData, overrideConfig)
            const reactFlowNodeData: INodeData = resolveVariables(flowNodeData, flowNodes, question)

            flowNodes[nodeIndex].data.instance = await newNodeInstance.init(reactFlowNodeData, question)
        } catch (e: any) {
            console.error(e)
            throw new Error(e)
        }

        const neighbourNodeIds = graph[nodeId]
        const nextDepth = depth + 1

        // Find other nodes that are on the same depth level
        const sameDepthNodeIds = Object.keys(depthQueue).filter((key) => depthQueue[key] === nextDepth)

        for (const id of sameDepthNodeIds) {
            if (neighbourNodeIds.includes(id)) continue
            neighbourNodeIds.push(id)
        }

        for (let i = 0; i < neighbourNodeIds.length; i += 1) {
            const neighNodeId = neighbourNodeIds[i]

            // If nodeId has been seen, cycle detected
            if (Object.prototype.hasOwnProperty.call(exploredNode, neighNodeId)) {
                const { remainingLoop, lastSeenDepth } = exploredNode[neighNodeId]

                if (lastSeenDepth === nextDepth) continue

                if (remainingLoop === 0) {
                    break
                }
                const remainingLoopMinusOne = remainingLoop - 1
                exploredNode[neighNodeId] = { remainingLoop: remainingLoopMinusOne, lastSeenDepth: nextDepth }
                nodeQueue.push({ nodeId: neighNodeId, depth: nextDepth })
            } else {
                exploredNode[neighNodeId] = { remainingLoop: maxLoop, lastSeenDepth: nextDepth }
                nodeQueue.push({ nodeId: neighNodeId, depth: nextDepth })
            }
        }
    }
    return flowNodes
}

/**
 * Get variable value from outputResponses.output
 * @param {string} paramValue
 * @param {IReactFlowNode[]} reactFlowNodes
 * @param {string} question
 * @param {boolean} isAcceptVariable
 * @returns {string}
 */
export const getVariableValue = (paramValue: string, reactFlowNodes: IReactFlowNode[], question: string, isAcceptVariable = false) => {
    let returnVal = paramValue
    const variableStack = []
    const variableDict = {} as IVariableDict
    let startIdx = 0
    const endIdx = returnVal.length - 1

    while (startIdx < endIdx) {
        const substr = returnVal.substring(startIdx, startIdx + 2)

        // Store the opening double curly bracket
        if (substr === '{{') {
            variableStack.push({ substr, startIdx: startIdx + 2 })
        }

        // Found the complete variable
        if (substr === '}}' && variableStack.length > 0 && variableStack[variableStack.length - 1].substr === '{{') {
            const variableStartIdx = variableStack[variableStack.length - 1].startIdx
            const variableEndIdx = startIdx
            const variableFullPath = returnVal.substring(variableStartIdx, variableEndIdx)

            if (isAcceptVariable && variableFullPath === QUESTION_VAR_PREFIX) {
                variableDict[`{{${variableFullPath}}}`] = question
            }

            // Split by first occurrence of '.' to get just nodeId
            const [variableNodeId, _] = variableFullPath.split('.')
            const executedNode = reactFlowNodes.find((nd) => nd.id === variableNodeId)
            if (executedNode) {
                const variableValue = get(executedNode.data, 'instance')
                if (isAcceptVariable) {
                    variableDict[`{{${variableFullPath}}}`] = variableValue
                } else {
                    returnVal = variableValue
                }
            }
            variableStack.pop()
        }
        startIdx += 1
    }

    if (isAcceptVariable) {
        const variablePaths = Object.keys(variableDict)
        variablePaths.sort() // Sort by length of variable path because longer path could possibly contains nested variable
        variablePaths.forEach((path) => {
            const variableValue = variableDict[path]
            // Replace all occurrence
            returnVal = returnVal.split(path).join(variableValue)
        })
        return returnVal
    }
    return returnVal
}

/**
 * Loop through each inputs and resolve variable if neccessary
 * @param {INodeData} reactFlowNodeData
 * @param {IReactFlowNode[]} reactFlowNodes
 * @param {string} question
 * @returns {INodeData}
 */
export const resolveVariables = (reactFlowNodeData: INodeData, reactFlowNodes: IReactFlowNode[], question: string): INodeData => {
    const flowNodeData = cloneDeep(reactFlowNodeData)
    const types = 'inputs'

    const getParamValues = (paramsObj: ICommonObject) => {
        for (const key in paramsObj) {
            const paramValue: string = paramsObj[key]
            if (Array.isArray(paramValue)) {
                const resolvedInstances = []
                for (const param of paramValue) {
                    const resolvedInstance = getVariableValue(param, reactFlowNodes, question)
                    resolvedInstances.push(resolvedInstance)
                }
                paramsObj[key] = resolvedInstances
            } else {
                const isAcceptVariable = reactFlowNodeData.inputParams.find((param) => param.name === key)?.acceptVariable ?? false
                const resolvedInstance = getVariableValue(paramValue, reactFlowNodes, question, isAcceptVariable)
                paramsObj[key] = resolvedInstance
            }
        }
    }

    const paramsObj = flowNodeData[types] ?? {}

    getParamValues(paramsObj)

    return flowNodeData
}

/**
 * Loop through each inputs and replace their value with override config values
 * @param {INodeData} flowNodeData
 * @param {ICommonObject} overrideConfig
 * @returns {INodeData}
 */
export const replaceInputsWithConfig = (flowNodeData: INodeData, overrideConfig: ICommonObject) => {
    const types = 'inputs'

    const getParamValues = (paramsObj: ICommonObject) => {
        for (const key in paramsObj) {
            const paramValue: string = paramsObj[key]
            paramsObj[key] = overrideConfig[key] ?? paramValue
        }
    }

    const paramsObj = flowNodeData[types] ?? {}

    getParamValues(paramsObj)

    return flowNodeData
}

/**
 * Rebuild flow if LLMChain has dependency on other chains
 * User Question => Prompt_0 => LLMChain_0 => Prompt-1 => LLMChain_1
 * @param {IReactFlowNode[]} startingNodes
 * @returns {boolean}
 */
export const isStartNodeDependOnInput = (startingNodes: IReactFlowNode[]): boolean => {
    for (const node of startingNodes) {
        for (const inputName in node.data.inputs) {
            const inputVariables = getInputVariables(node.data.inputs[inputName])
            if (inputVariables.length > 0) return true
        }
    }
    return false
}

/**
 * Rebuild flow if new override config is provided
 * @param {boolean} isInternal
 * @param {ICommonObject} existingOverrideConfig
 * @param {ICommonObject} newOverrideConfig
 * @returns {boolean}
 */
export const isSameOverrideConfig = (
    isInternal: boolean,
    existingOverrideConfig?: ICommonObject,
    newOverrideConfig?: ICommonObject
): boolean => {
    // Skip check if its internal call
    if (isInternal) return true
    // If existing and new overrideconfig are the same
    if (
        existingOverrideConfig &&
        Object.keys(existingOverrideConfig).length &&
        newOverrideConfig &&
        Object.keys(newOverrideConfig).length &&
        JSON.stringify(existingOverrideConfig) === JSON.stringify(newOverrideConfig)
    ) {
        return true
    }
    // If there is no existing and new overrideconfig
    if (!existingOverrideConfig && !newOverrideConfig) return true
    return false
}

/**
 * Returns the api key path
 * @returns {string}
 */
export const getAPIKeyPath = (): string => {
    return path.join(__dirname, '..', '..', 'api.json')
}

/**
 * Generate the api key
 * @returns {string}
 */
export const generateAPIKey = (): string => {
    const buffer = randomBytes(32)
    return buffer.toString('base64')
}

/**
 * Generate the secret key
 * @param {string} apiKey
 * @returns {string}
 */
export const generateSecretHash = (apiKey: string): string => {
    const salt = randomBytes(8).toString('hex')
    const buffer = scryptSync(apiKey, salt, 64) as Buffer
    return `${buffer.toString('hex')}.${salt}`
}

/**
 * Verify valid keys
 * @param {string} storedKey
 * @param {string} suppliedKey
 * @returns {boolean}
 */
export const compareKeys = (storedKey: string, suppliedKey: string): boolean => {
    const [hashedPassword, salt] = storedKey.split('.')
    const buffer = scryptSync(suppliedKey, salt, 64) as Buffer
    return timingSafeEqual(Buffer.from(hashedPassword, 'hex'), buffer)
}

/**
 * Get API keys
 * @returns {Promise<ICommonObject[]>}
 */
export const getAPIKeys = async (): Promise<ICommonObject[]> => {
    try {
        const content = await fs.promises.readFile(getAPIKeyPath(), 'utf8')
        return JSON.parse(content)
    } catch (error) {
        const keyName = 'DefaultKey'
        const apiKey = generateAPIKey()
        const apiSecret = generateSecretHash(apiKey)
        const content = [
            {
                keyName,
                apiKey,
                apiSecret,
                createdAt: moment().format('DD-MMM-YY'),
                id: randomBytes(16).toString('hex')
            }
        ]
        await fs.promises.writeFile(getAPIKeyPath(), JSON.stringify(content), 'utf8')
        return content
    }
}

/**
 * Add new API key
 * @param {string} keyName
 * @returns {Promise<ICommonObject[]>}
 */
export const addAPIKey = async (keyName: string): Promise<ICommonObject[]> => {
    const existingAPIKeys = await getAPIKeys()
    const apiKey = generateAPIKey()
    const apiSecret = generateSecretHash(apiKey)
    const content = [
        ...existingAPIKeys,
        {
            keyName,
            apiKey,
            apiSecret,
            createdAt: moment().format('DD-MMM-YY'),
            id: randomBytes(16).toString('hex')
        }
    ]
    await fs.promises.writeFile(getAPIKeyPath(), JSON.stringify(content), 'utf8')
    return content
}

/**
 * Update existing API key
 * @param {string} keyIdToUpdate
 * @param {string} newKeyName
 * @returns {Promise<ICommonObject[]>}
 */
export const updateAPIKey = async (keyIdToUpdate: string, newKeyName: string): Promise<ICommonObject[]> => {
    const existingAPIKeys = await getAPIKeys()
    const keyIndex = existingAPIKeys.findIndex((key) => key.id === keyIdToUpdate)
    if (keyIndex < 0) return []
    existingAPIKeys[keyIndex].keyName = newKeyName
    await fs.promises.writeFile(getAPIKeyPath(), JSON.stringify(existingAPIKeys), 'utf8')
    return existingAPIKeys
}

/**
 * Delete API key
 * @param {string} keyIdToDelete
 * @returns {Promise<ICommonObject[]>}
 */
export const deleteAPIKey = async (keyIdToDelete: string): Promise<ICommonObject[]> => {
    const existingAPIKeys = await getAPIKeys()
    const result = existingAPIKeys.filter((key) => key.id !== keyIdToDelete)
    await fs.promises.writeFile(getAPIKeyPath(), JSON.stringify(result), 'utf8')
    return result
}

/**
 * Map MimeType to InputField
 * @param {string} mimeType
 * @returns {Promise<string>}
 */
export const mapMimeTypeToInputField = (mimeType: string) => {
    switch (mimeType) {
        case 'text/plain':
            return 'txtFile'
        case 'application/pdf':
            return 'pdfFile'
        case 'application/json':
            return 'jsonFile'
        case 'text/csv':
            return 'csvFile'
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
            return 'docxFile'
        default:
            return ''
    }
}

/**
 * Find all available inpur params config
 * @param {IReactFlowNode[]} reactFlowNodes
 * @returns {Promise<IOverrideConfig[]>}
 */
export const findAvailableConfigs = (reactFlowNodes: IReactFlowNode[]) => {
    const configs: IOverrideConfig[] = []

    for (const flowNode of reactFlowNodes) {
        for (const inputParam of flowNode.data.inputParams) {
            let obj: IOverrideConfig
            if (inputParam.type === 'password' || inputParam.type === 'options') {
                continue
            } else if (inputParam.type === 'file') {
                obj = {
                    node: flowNode.data.label,
                    label: inputParam.label,
                    name: 'files',
                    type: inputParam.fileType ?? inputParam.type
                }
            } else {
                obj = {
                    node: flowNode.data.label,
                    label: inputParam.label,
                    name: inputParam.name,
                    type: inputParam.type
                }
            }
            if (!configs.some((config) => JSON.stringify(config) === JSON.stringify(obj))) {
                configs.push(obj)
            }
        }
    }

    return configs
}
