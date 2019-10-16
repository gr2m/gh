/**
 * © 2013 Liferay, Inc. <https://liferay.com> and Node GH contributors
 * (see file: README.md)
 * SPDX-License-Identifier: BSD-3-Clause
 */

// -- Requires -------------------------------------------------------------------------------------

import * as fs from 'fs'
import * as nopt from 'nopt'
import * as path from 'path'
import * as updateNotifier from 'update-notifier'
import * as R from 'ramda'
import { find, getUser } from './base'
import {
    getConfig,
    getPlugin,
    addPluginConfig,
    getGlobalPackageJson,
    getUserHomePath,
    createGlobalConfig,
} from './configs'
import * as git from './git'
import { produce, setAutoFreeze } from 'immer'
import { getGitHubInstance } from './github'
import { Just, Nothing, isNothing, isLeft } from 'sanctuary'
import { error, colors } from './logger'

const config = getConfig()

// allows to run program as js or ts
const extension = __filename.slice(__filename.lastIndexOf('.') + 1)

const testing = process.env.NODE_ENV === 'testing'

// interface Command {
//     name: string
//     isPlugin?: boolean
//     DETAILS: {
//         alias: string
//         description: string
//         commands: string
//         options: object
//         shorthands: object
//     }
//     run: () => {}
// }

// -- Utils ----------------------------------------------------------------------------------------

function resolveCmd(name, commandDir) {
    const reg = new RegExp(`.${extension}$`, 'i')
    const commandFiles = find(commandDir, reg)

    const commandName = commandFiles.filter(file => {
        switch (file) {
            case `milestone.${extension}`:
                if (name === 'ms') return true
                break
            case `notification.${extension}`:
                if (name === 'nt') return true
                break
            case `pull-request.${extension}`:
                if (name === 'pr') return true
                break
        }

        if (file.startsWith(name)) {
            return true
        }

        return false
    })[0]

    return commandName && import(path.join(commandDir, commandName))
}

async function resolvePlugin(name) {
    const plugin = getPlugin(Just(name))

    if (isLeft(plugin)) {
        error(`Could not resolve plugin ${colors.red(name)}`, plugin.value)
    }

    const pluginFullName = plugin.Impl.name.toLowerCase()

    plugin && addPluginConfig(pluginFullName)

    return plugin ? Just(plugin) : Nothing
}

function setProp(propName, value) {
    return function setObjectProp(object) {
        return Object.assign({}, object, { [propName]: value })
    }
}

async function loadCommand(name) {
    let Command

    const commandDir = path.join(__dirname, 'cmds')
    const commandPath = path.join(commandDir, `${name}.${extension}`)

    if (fs.existsSync(commandPath)) {
        Command = await import(commandPath)
    } else {
        Command = await resolveCmd(name, commandDir)
    }

    if (!Command) {
        // Try to resolve as plugin
        const { Impl } = await resolvePlugin(name)

        Impl.map(setProp('isPlugin', true))

        Command = Impl
    }

    return Command
}

async function getCommand(args) {
    /**
     * nopt function returns:
     *
     * remain: The remaining args after all the parsing has occurred.
     * original: The args as they originally appeared.
     * cooked: The args after flags and shorthands are expanded.
     */
    const parsed = nopt(args)
    const remain = parsed.argv.remain
    const cooked = parsed.argv.cooked
    let module = remain[0]

    if (cooked[0] === '--version' || cooked[0] === '-v') {
        module = 'version'
    } else if (!remain.length || cooked.indexOf('-h') >= 0 || cooked.indexOf('--help') >= 0) {
        module = 'help'
    }

    var Command = await loadCommand(module)
    // throw new Error(`Cannot find module ${module}\n${err}`)

    if (!Command) {
        throw new Error(`No cmd or plugin found.`)
    }

    return Command
}

function notifyVersion(): void {
    const notifier = updateNotifier({ pkg: getGlobalPackageJson() })

    if (notifier.update) {
        notifier.notify()
    }
}

export async function setUp() {
    notifyVersion()

    const Command = await getCommand(process.argv)

    const args = await R.pipe(
        getCommand,
        getArgs
    )(process.argv)

    // Allow mutation of options when not testing
    // https://immerjs.github.io/immer/docs/freezing
    !testing && setAutoFreeze(false)

    if (testing) {
        var { prepareTestFixtures } = await import('./utils')

        // Enable mock apis for e2e's
        var cmdDoneRunning = prepareTestFixtures(Command.name, args.argv.cooked)
    }

    const options = await produce(args, async draft => {
        // Gets 2nd positional arg (`gh pr 1` will return 1)
        const secondArg = [draft.argv.remain[1]]
        const remote = draft.remote || config.default_remote
        const remoteUrl = git.getRemoteUrl(remote)

        if (Command.name !== 'Help' && Command.name !== 'Version') {
            // We don't want to boot up Ocktokit if user just wants help or version
            draft.GitHub = await getGitHubInstance()
        }

        draft.remote = remote
        draft.number = draft.number || secondArg
        draft.loggedUser = getUser()
        draft.remoteUser = git.getUserFromRemoteUrl(remoteUrl)
        draft.repo = draft.repo || git.getRepoFromRemoteURL(remoteUrl)
        draft.currentBranch = git.getCurrentBranch()
        draft.github_host = config.github_host
        draft.github_gist_host = config.github_gist_host

        if (!draft.user) {
            if (args.repo || args.all) {
                draft.user = draft.loggedUser
            } else {
                draft.user = process.env.GH_USER || draft.remoteUser || draft.loggedUser
            }
        }

        /**
         * Checks if there are aliases in your .gh.json file.
         * If there are aliases in your .gh.json file, we will attempt to resolve the user, PR forwarder or PR submitter to your alias.
         */
        if (config.alias) {
            draft.fwd = config.alias[draft.fwd] || draft.fwd
            draft.submit = config.alias[draft.submit] || draft.submit
            draft.user = config.alias[draft.user] || draft.user
        }
    })

    if (testing) {
        if (Command.isPlugin) {
            await new Command(options).run(cmdDoneRunning)
        } else {
            await Command.run(options, cmdDoneRunning)
        }
    } else {
        if (Command.isPlugin) {
            await new Command(options).run()
        } else {
            await Command.run(options)
        }
    }
}

export async function run() {
    if (!fs.existsSync(getUserHomePath())) {
        createGlobalConfig()
    }

    try {
        process.env.GH_PATH = path.join(__dirname, '../')

        await setUp()
    } catch (e) {
        console.error(e.stack || e)
    }
}

/**
 * If you run `gh pr 1 -s node-gh --remote=origin --user protoEvangelion`, nopt will return
 *
 *   {
 *     remote: 'origin',
 *     submit: 'node-gh',
 *     user: 'protoEvangelion',
 *     argv: {
 *         original: ['pr', '1', '-s', 'pr', 'node-gh', '--remote', 'origin', '--user', 'protoEvangelion'],
 *         remain: ['pr', '1'],
 *         cooked: ['pr', '1', '--submit', 'node-gh', '--remote', 'origin', '--user', 'protoEvangelion'],
 *     },
 *   }
 *
 * Historically we passed every arg after 2nd arg (gh pr 1 -s user; everything after 'pr')
 * and all parsed options to each cmd's payload function to figure out positional args and allow for neat shortcuts like:
 * gh is 'new issue' 'new issue description'
 */
async function getArgs(Command) {
    Command = await Command

    return nopt(Command.DETAILS.options, Command.DETAILS.shorthands, process.argv, 2)
}
