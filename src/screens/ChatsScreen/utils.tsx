import { useEffect, createElement, memo, useRef, Fragment } from "react"
import { ChatMessage, ChatConversationParticipant, chatConversations, ChatConversation, chatMessages, UserGetAccount } from "../../lib/api"
import { dbFs } from "../../lib/db"
import { decryptChatMessage, decryptChatConversationName } from "../../lib/crypto"
import { validate } from "uuid"
import eventListener from "../../lib/eventListener"
import storage from "../../lib/storage"
import regexifyString from "regexify-string"
import EMOJI_REGEX from "emojibase-regex"
import { View, Text, Linking, TextInput } from "react-native"
import { getColor } from "../../style"
import { customEmojis } from "./customEmojis"
import { Image } from "expo-image"
import EmojiConvertor from "emoji-js"
import axios, { AxiosResponse } from "axios"

export type MessageDisplayType = "image" | "ogEmbed" | "youtubeEmbed" | "twitterEmbed" | "filenEmbed" | "async" | "none" | "invalid"
export type DisplayMessageAs = Record<string, MessageDisplayType>

export const MENTION_REGEX = /(@[\w.-]+@[\w.-]+\.\w+|@everyone)/g
export const customEmojisList = customEmojis.map(emoji => emoji.id)
export const customEmojisListRecord = customEmojis.reduce((prev, value) => ({ ...prev, [value.id]: value.skins[0].src }), {})

const emojiConvertor = new EmojiConvertor()

export const getUserNameFromMessage = (message: ChatMessage): string => {
	return message.senderNickName.length > 0 ? message.senderNickName : message.senderEmail
}

export const getUserNameFromReplyTo = (message: ChatMessage): string => {
	return message.replyTo.senderNickName.length > 0 ? message.replyTo.senderNickName : message.replyTo.senderEmail
}

export const getUserNameFromParticipant = (participant: ChatConversationParticipant): string => {
	return participant.nickName.length > 0 ? participant.nickName : participant.email
}

export const getUserNameFromAccount = (account: UserGetAccount): string => {
	return account.nickName.length > 0 ? account.nickName : account.email
}

export const formatDate = (date: Date): string => {
	return date.toLocaleDateString(window.navigator.language, { year: "numeric", month: "2-digit", day: "2-digit" })
}

export const formatTime = (date: Date): string => {
	return date.toLocaleTimeString(window.navigator.language, { hour: "2-digit", minute: "2-digit" })
}

export const formatMessageDate = (timestamp: number, lang: string = "en"): string => {
	const now = Date.now()
	const nowDate = new Date()
	const thenDate = new Date(timestamp)
	const diff = now - timestamp
	const seconds = Math.floor(diff / 1000)
	const nowDay = nowDate.getDate()
	const thenDay = thenDate.getDate()

	if (seconds <= 0) {
		return "now"
	}

	if (seconds < 60) {
		return `${seconds} seconds ago`
	}

	if (seconds < 3600) {
		const minutes = Math.floor(seconds / 60)

		return `${minutes} minute${minutes > 1 ? "s" : ""} ago`
	}

	if (seconds < 3600 * 4) {
		const hours = Math.floor(seconds / 3600)

		return `${hours} hour${hours > 1 ? "s" : ""} ago`
	}

	if (nowDay === thenDay) {
		const date = new Date(timestamp)

		return `Today at ${formatTime(date)}`
	}

	if (nowDay - 1 === thenDay) {
		const date = new Date(timestamp)

		return `Yesterday at ${formatTime(date)}`
	}

	return `${formatDate(thenDate)} ${formatTime(thenDate)}`
}

export const isTimestampSameDay = (timestamp1: number, timestamp2: number) => {
	const date1 = new Date(timestamp1)
	const date2 = new Date(timestamp2)

	return date1.getFullYear() === date2.getFullYear() && date1.getMonth() === date2.getMonth() && date1.getDate() === date2.getDate()
}

export const isTimestampSameMinute = (timestamp1: number, timestamp2: number) => {
	const date1 = new Date(timestamp1)
	const date2 = new Date(timestamp2)
	const date1Year = date1.getFullYear()
	const date1Month = date1.getMonth()
	const date1Date = date1.getDate()
	const date1Minutes = date1.getMinutes()
	const date2Year = date2.getFullYear()
	const date2Month = date2.getMonth()
	const date2Date = date2.getDate()
	const date2Minutes = date2.getMinutes()
	const date1Hours = date1.getHours()
	const date2Hours = date2.getHours()

	return (
		date1Year === date2Year &&
		date1Month === date2Month &&
		date1Date === date2Date &&
		date1Hours === date2Hours &&
		(date1Minutes === date2Minutes ||
			date1Minutes - 1 === date2Minutes ||
			date1Minutes === date2Minutes - 1 ||
			date1Minutes + 1 === date2Minutes ||
			date1Minutes === date2Minutes + 1 ||
			date1Minutes - 2 === date2Minutes ||
			date1Minutes === date2Minutes - 2 ||
			date1Minutes + 2 === date2Minutes ||
			date1Minutes === date2Minutes + 2)
	)
}

export interface FetchChatConversationsResult {
	cache: boolean
	conversations: ChatConversation[]
}

export const fetchChatConversations = async (skipCache: boolean = false): Promise<FetchChatConversationsResult> => {
	const refresh = async (): Promise<FetchChatConversationsResult> => {
		const conversationsDecrypted: ChatConversation[] = []
		const privateKey = storage.getString("privateKey")
		const userId = storage.getNumber("userId")
		const result = await chatConversations()
		const promises: Promise<void>[] = []

		for (const conversation of result) {
			promises.push(
				new Promise(async (resolve, reject) => {
					try {
						const metadata = conversation.participants.filter(p => p.userId === userId)

						if (metadata.length !== 1) {
							resolve()

							return
						}

						const nameDecrypted =
							typeof conversation.name === "string" && conversation.name.length > 0
								? await decryptChatConversationName(conversation.name, metadata[0].metadata, privateKey)
								: ""
						const messageDecrypted =
							typeof conversation.lastMessage === "string" && conversation.lastMessage.length > 0
								? await decryptChatMessage(conversation.lastMessage, metadata[0].metadata, privateKey)
								: ""

						conversationsDecrypted.push({
							...conversation,
							name: nameDecrypted,
							lastMessage: messageDecrypted
						})
					} catch (e) {
						reject(e)

						return
					}

					resolve()
				})
			)
		}

		await Promise.all(promises)

		await dbFs.set("chatConversations", conversationsDecrypted).catch(console.error)

		cleanupLocalDb(conversationsDecrypted).catch(console.error)

		return {
			conversations: conversationsDecrypted,
			cache: false
		}
	}

	if (skipCache) {
		return await refresh()
	}

	const cache = await dbFs.get<ChatConversation[]>("chatConversations")

	if (cache) {
		return {
			cache: true,
			conversations: cache
		}
	}

	return await refresh()
}

export interface FetchChatMessagesResult {
	cache: boolean
	messages: ChatMessage[]
}

export const fetchChatMessages = async (
	conversationUUID: string,
	metadata: string,
	timestamp: number = Date.now() + 3600000,
	skipCache: boolean = false,
	saveToLocalDb: boolean = true
): Promise<FetchChatMessagesResult> => {
	const refresh = async (): Promise<FetchChatMessagesResult> => {
		const messagesDecrypted: ChatMessage[] = []
		const privateKey = storage.getString("privateKey")
		const result = await chatMessages(conversationUUID, timestamp)
		const promises: Promise<void>[] = []

		for (const message of result) {
			promises.push(
				new Promise(async (resolve, reject) => {
					try {
						const messageDecrypted = await decryptChatMessage(message.message, metadata, privateKey)
						const replyToMessageDecrypted =
							message.replyTo.uuid.length > 0 && message.replyTo.message.length > 0
								? await decryptChatMessage(message.replyTo.message, metadata, privateKey)
								: ""

						if (messageDecrypted.length === 0) {
							resolve()

							return
						}

						messagesDecrypted.push({
							...message,
							message: messageDecrypted,
							replyTo: {
								...message.replyTo,
								message: replyToMessageDecrypted
							}
						})
					} catch (e) {
						reject(e)

						return
					}

					resolve()
				})
			)
		}

		await Promise.all(promises)

		if (saveToLocalDb) {
			await dbFs.set("chatMessages:" + conversationUUID, messagesDecrypted.slice(-100)).catch(console.error)
		}

		return {
			messages: messagesDecrypted,
			cache: false
		}
	}

	if (skipCache) {
		return await refresh()
	}

	const cache = await dbFs.get<ChatMessage[]>("chatMessages:" + conversationUUID)

	if (cache) {
		return {
			cache: true,
			messages: cache
		}
	}

	return await refresh()
}

export const parseYouTubeVideoId = (url: string): string | null => {
	const regExp = /(?:\?v=|\/embed\/|\/watch\?v=|\/\w+\/\w+\/|youtu.be\/)([\w-]{11})/
	const match = url.match(regExp)

	if (match && match.length === 2) {
		return match[1]
	}

	return null
}

export const parseFilenPublicLink = (url: string) => {
	const ex = url.split("/")
	const uuid = ex.map(part => part.split("#")[0].trim()).filter(part => validate(part))
	const keyEx = url.split("#")

	return {
		uuid: uuid.length > 0 ? uuid[0] : "",
		key: url.indexOf("#") !== -1 ? keyEx[1].trim() : ""
	}
}

export const extractLinksFromString = (input: string): string[] => {
	const urlRegex =
		/(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})/gi

	const matches = input.match(urlRegex)

	return matches || []
}

export const isMessageLink = (message: string) => {
	if (message.split(" ").length >= 2 || message.split("\n").length >= 2) {
		return false
	}

	const trimmed = message.trim()

	if (trimmed.indexOf("/localhost:") !== -1 && trimmed.startsWith("http://localhost:")) {
		return true
	}

	const urlRegex =
		/(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})/gi

	return urlRegex.test(trimmed)
}

export const getMessageDisplayType = (message: string): MessageDisplayType => {
	const isLink = isMessageLink(message)

	if (!isLink) {
		return "none"
	}

	if (
		message.indexOf("/youtube.com/watch") !== -1 ||
		message.indexOf("/youtube.com/embed") !== -1 ||
		message.indexOf("/www.youtube.com/watch") !== -1 ||
		message.indexOf("/www.youtube.com/embed") !== -1 ||
		message.indexOf("/youtu.be/") !== -1 ||
		message.indexOf("/www.youtu.be/") !== -1
	) {
		return "youtubeEmbed"
	} else if (
		(message.indexOf("/localhost:") !== -1 ||
			message.indexOf("/filen.io/") !== -1 ||
			message.indexOf("/drive.filen.io/") !== -1 ||
			message.indexOf("/drive.filen.dev/") !== -1 ||
			message.indexOf("/www.filen.io/") !== -1) &&
		message.indexOf("/d/") !== -1
	) {
		return "filenEmbed"
	} else if (
		(message.indexOf("/www.twitter.com/") !== -1 || message.indexOf("/twitter.com/") !== -1) &&
		message.indexOf("/status/") !== -1
	) {
		return "twitterEmbed"
	}

	return "async"
}

export const parseTwitterStatusIdFromURL = (url: string) => {
	const ex = url.split("/")

	return ex[ex.length - 1].trim()
}

export const cleanupLocalDb = async (conversations: ChatConversation[]) => {
	// TODO
}

export const sortAndFilterConversations = (conversations: ChatConversation[], search: string, userId: number) => {
	return conversations
		.filter(convo => convo.participants.length >= 1 && (convo.lastMessageTimestamp > 0 || userId === convo.ownerId))
		.filter(convo => {
			if (search.length === 0) {
				return true
			}

			if (
				convo.participants
					.map(p => getUserNameFromParticipant(p))
					.join(", ")
					.toLowerCase()
					.trim()
					.indexOf(search.toLowerCase().trim()) !== -1
			) {
				return true
			}

			if (convo.lastMessage?.toLowerCase().trim().indexOf(search.toLowerCase().trim()) !== -1) {
				return true
			}

			return false
		})
		.sort((a, b) => {
			if (a.lastMessageTimestamp > 0 && b.lastMessageTimestamp > 0) {
				return b.lastMessageTimestamp - a.lastMessageTimestamp
			} else if (a.lastMessageTimestamp === 0 && b.lastMessageTimestamp === 0) {
				return b.createdTimestamp - a.createdTimestamp
			} else {
				return b.lastMessageTimestamp - a.lastMessageTimestamp
			}
		})
}

export const ReplaceMessageWithComponents = memo(
	({
		content,
		darkMode,
		participants,
		failed
	}: {
		content: string
		darkMode: boolean
		participants: ChatConversationParticipant[]
		failed: boolean
	}) => {
		const lineBreakRegex = /\n/
		const codeRegex = /```([\s\S]*?)```/
		const linkRegex = /(https?:\/\/\S+)/
		const emojiRegexWithSkinTones = /:[\d+_a-z-]+(?:::skin-tone-\d+)?:/
		const mentions = /(@[\w.-]+@[\w.-]+\.\w+|@everyone)/
		const emojiRegex = new RegExp(`${EMOJI_REGEX.source}|${emojiRegexWithSkinTones.source}`)
		const regex = new RegExp(
			`${EMOJI_REGEX.source}|${emojiRegexWithSkinTones.source}|${codeRegex.source}|${lineBreakRegex.source}|${linkRegex.source}|${mentions.source}`
		)
		const emojiCount = content.match(emojiRegex)
		const defaultSize = 28
		let size: number | undefined = defaultSize

		if (emojiCount) {
			const emojiCountJoined = emojiCount.join("")

			if (emojiCountJoined.length !== content.length) {
				size = 20
			}
		}

		const replaced = regexifyString({
			pattern: regex,
			decorator: (match, index) => {
				if (match.startsWith("@") && (match.split("@").length === 3 || match.startsWith("@everyone"))) {
					const email = match.slice(1).trim()

					if (email === "everyone") {
						return (
							<Fragment key={match + ":" + index}>
								<Text>@everyone</Text>
							</Fragment>
						)
					}

					if (email.indexOf("@") === -1) {
						return (
							<Fragment key={match + ":" + index}>
								<Text>@UnknownUser</Text>
							</Fragment>
						)
					}

					const foundParticipant = participants.filter(p => p.email === email)

					if (foundParticipant.length === 0) {
						return (
							<Fragment key={match + ":" + index}>
								<Text>@UnknownUser</Text>
							</Fragment>
						)
					}

					return (
						<Fragment key={match + ":" + index}>
							<Text
								style={{
									color: failed ? getColor(darkMode, "red") : getColor(darkMode, "textPrimary")
								}}
								onPress={() => eventListener.emit("openUserProfileModal", foundParticipant[0].userId)}
							>
								@{getUserNameFromParticipant(foundParticipant[0])}
							</Text>
						</Fragment>
					)
				}

				if (match.split("```").length >= 3) {
					const code = match.split("```").join("")

					return (
						<TextInput
							key={match + ":" + index}
							style={{
								maxWidth: "100%",
								backgroundColor: getColor(darkMode, "backgroundSecondary"),
								borderRadius: 5,
								flexDirection: "row",
								marginTop: 5,
								color: getColor(darkMode, "textPrimary"),
								padding: 10
							}}
							value={code}
							selectTextOnFocus={false}
							autoCorrect={false}
							autoFocus={false}
							autoCapitalize="none"
							autoComplete="off"
							scrollEnabled={false}
							editable={false}
							multiline={true}
						/>
					)
				}

				if (linkRegex.test(match) && (match.startsWith("https://") || match.startsWith("http://"))) {
					return (
						<Text
							key={match + ":" + index}
							style={{
								color: failed ? getColor(darkMode, "red") : getColor(darkMode, "linkPrimary")
							}}
							onPress={() => Linking.openURL(match).catch(console.error)}
						>
							{match}
						</Text>
					)
				}

				if (match.indexOf("\n") !== -1) {
					return (
						<View
							key={match + ":" + index}
							style={{
								height: 5,
								width: "100%",
								flexBasis: "100%"
							}}
						/>
					)
				}

				const customEmoji = match.split(":").join("").trim()

				if (customEmojisList.includes(customEmoji) && customEmojisListRecord[customEmoji]) {
					return (
						<Image
							key={match + ":" + index}
							source={{
								uri: customEmojisListRecord[customEmoji]
							}}
							cachePolicy="memory-disk"
							style={{
								width: size,
								height: size,
								borderRadius: 3,
								flexShrink: 0,
								marginLeft: size === defaultSize ? 0 : 5,
								marginRight: size === defaultSize ? 0 : 5
							}}
						/>
					)
				}

				return (
					<View
						key={match + ":" + index}
						style={{
							width: size === defaultSize ? "auto" : size + 8,
							flexDirection: "row",
							alignItems: "center",
							justifyContent: "center"
						}}
					>
						<Text
							style={{
								color: getColor(darkMode, "textPrimary"),
								fontSize: size,
								lineHeight: size + 3
							}}
						>
							{emojiConvertor.replace_colons(match)}
						</Text>
					</View>
				)
			},
			input: content
		})

		return (
			<>
				{replaced.map((r, index) => {
					if (typeof r === "string") {
						return (
							<Text
								key={index}
								style={{
									color: getColor(darkMode, "textPrimary"),
									fontSize: 15,
									width: "auto",
									flexDirection: "row",
									flexShrink: 0,
									alignItems: "center",
									lineHeight: 24
								}}
							>
								{r.trim()}
							</Text>
						)
					}

					return (
						<View
							key={index}
							style={{
								width: "auto",
								flexDirection: "row",
								flexShrink: 0,
								alignItems: "center"
							}}
						>
							{r}
						</View>
					)
				})}
			</>
		)
	}
)

export const ReplaceInlineMessageWithComponents = memo(
	({
		content,
		darkMode,
		emojiSize,
		hideLinks,
		hideMentions,
		participants,
		color,
		fontSize
	}: {
		content: string
		darkMode: boolean
		emojiSize?: number
		hideLinks?: boolean
		hideMentions?: boolean
		participants: ChatConversationParticipant[]
		color?: string
		fontSize?: number
	}) => {
		const codeRegex = /```([\s\S]*?)```/
		const linkRegex = /(https?:\/\/\S+)/
		const emojiRegexWithSkinTones = /:[\d+_a-z-]+(?:::skin-tone-\d+)?:/
		const mentions = /(@[\w.-]+@[\w.-]+\.\w+|@everyone)/
		const regex = new RegExp(
			`${EMOJI_REGEX.source}|${emojiRegexWithSkinTones.source}|${codeRegex.source}|${linkRegex.source}|${mentions.source}`
		)
		const defaultSize = emojiSize ? emojiSize : 16
		let size: number | undefined = defaultSize

		const replaced = regexifyString({
			pattern: regex,
			decorator: (match, index) => {
				if (match.startsWith("@") && (match.split("@").length === 3 || match.startsWith("@everyone"))) {
					const email = match.slice(1).trim()

					if (email === "everyone") {
						return (
							<Fragment key={match + ":" + index}>
								<Text
									style={{
										color: color ? color : getColor(darkMode, "textSecondary"),
										fontSize: fontSize ? fontSize : 15
									}}
								>
									@everyone
								</Text>
							</Fragment>
						)
					}

					const foundParticipant = participants.filter(p => p.email === email)

					if (foundParticipant.length === 0) {
						return (
							<Fragment key={match + ":" + index}>
								<Text
									style={{
										color: color ? color : getColor(darkMode, "textSecondary"),
										fontSize: fontSize ? fontSize : 15
									}}
								>
									@UnknownUser
								</Text>
							</Fragment>
						)
					}

					if (hideMentions) {
						return (
							<Fragment key={match + ":" + index}>
								<Text
									style={{
										color: color ? color : getColor(darkMode, "textSecondary"),
										fontSize: fontSize ? fontSize : 15
									}}
								>
									@{getUserNameFromParticipant(foundParticipant[0])}
								</Text>
							</Fragment>
						)
					}

					return (
						<Fragment key={match + ":" + index}>
							<Text
								style={{
									color: color ? color : getColor(darkMode, "textPrimary"),
									fontSize: fontSize ? fontSize : 15
								}}
							>
								@{getUserNameFromParticipant(foundParticipant[0])}
							</Text>
						</Fragment>
					)
				}

				if (linkRegex.test(match) && (match.startsWith("https://") || match.startsWith("http://"))) {
					if (hideLinks) {
						return (
							<Text
								key={match + ":" + index}
								style={{
									color: color ? color : getColor(darkMode, "textPrimary"),
									fontSize: fontSize ? fontSize : 15
								}}
							>
								{match}
							</Text>
						)
					}

					return (
						<Text
							key={match + ":" + index}
							style={{
								color: color ? color : getColor(darkMode, "linkPrimary"),
								fontSize: fontSize ? fontSize : 15
							}}
						>
							{match}
						</Text>
					)
				}

				const customEmoji = match.split(":").join("").trim()

				if (customEmojisList.includes(customEmoji) && customEmojisListRecord[customEmoji]) {
					return (
						<Image
							key={match + ":" + index}
							source={{
								uri: customEmojisListRecord[customEmoji]
							}}
							cachePolicy="memory-disk"
							style={{
								width: size,
								height: size,
								borderRadius: 3,
								flexShrink: 0,
								marginLeft: size === defaultSize ? 0 : 5,
								marginRight: size === defaultSize ? 0 : 5
							}}
						/>
					)
				}

				return (
					<View
						key={match + ":" + index}
						style={{
							width: size === defaultSize ? "auto" : size + 8,
							flexDirection: "row",
							alignItems: "center",
							justifyContent: "center"
						}}
					>
						<Text
							style={{
								color: color ? color : getColor(darkMode, "textPrimary"),
								fontSize: size,
								lineHeight: size + 3
							}}
						>
							{emojiConvertor.replace_colons(match)}
						</Text>
					</View>
				)
			},
			input: content.split("\n").join(" ").split("`").join("")
		})

		return (
			<>
				{replaced.map((r, index) => {
					if (typeof r === "string") {
						return (
							<Text
								key={index}
								style={{
									color: color ? color : getColor(darkMode, "textPrimary"),
									fontSize: fontSize ? fontSize : 15,
									width: "auto",
									flexDirection: "row",
									flexShrink: 0,
									alignItems: "center"
								}}
							>
								{r.trim()}
							</Text>
						)
					}

					return (
						<View
							key={index}
							style={{
								width: "auto",
								flexDirection: "row",
								flexShrink: 0,
								alignItems: "center"
							}}
						>
							{r}
						</View>
					)
				})}
			</>
		)
	}
)

export const headURL = async (url: string): Promise<Record<string, string>> => {
	const response = await axios.head(url, {
		timeout: 15000
	})

	if (typeof response.headers["content-type"] !== "string") {
		throw new Error("Response type is not string: " + url)
	}

	return response.headers
}

export const getURL = async (url: string): Promise<AxiosResponse> => {
	const response = await axios.get(url, {
		timeout: 15000
	})

	if (!response.data) {
		throw new Error("Could not get response body for " + url)
	}

	return response
}

export const parseOGFromURL = async (url: string): Promise<Record<string, string>> => {
	const response = await axios.get(url, {
		timeout: 15000
	})

	if (typeof response.headers["content-type"] !== "string" || response.headers["content-type"].split(";")[0].trim() !== "text/html") {
		throw new Error("Response type is not text/html: " + url)
	}

	const metadata: Record<string, string> = {}
	const ogTags = response.data.match(/<meta\s+property="og:([^"]+)"\s+content="([^"]+)"\s*\/?>/g)
	const ogTags2 = response.data.match(/<meta\s+property='og:([^']+)'\s+content='([^']+)'\s*\/?>/g)

	if (ogTags) {
		ogTags.forEach((tag: any) => {
			const [, property, content] = tag.match(/<meta\s+property="og:([^"]+)"\s+content="([^"]+)"\s*\/?>/)

			if (typeof property === "string" && typeof content === "string") {
				metadata["og:" + property] = content
			}
		})
	}

	if (ogTags2) {
		ogTags2.forEach((tag: any) => {
			const [, property, content] = tag.match(/<meta\s+property='og:([^']+)'\s+content='([^']+)'\s*\/?>/)

			if (typeof property === "string" && typeof content === "string") {
				metadata["og:" + property] = content
			}
		})
	}

	const otherTags = response.data.match(/<meta\s+name="([^"]+)"\s+content="([^"]+)"\s*\/?>/g)
	const otherTags2 = response.data.match(/<meta\s+name='([^']+)'\s+content='([^']+)'\s*\/?>/g)

	if (otherTags) {
		otherTags.forEach((tag: any) => {
			const [, name, content] = tag.match(/<meta\s+name="([^"]+)"\s+content="([^"]+)"\s*\/?>/)

			if (typeof name === "string" && typeof content === "string") {
				metadata["meta:" + name] = content
			}
		})
	}

	if (otherTags2) {
		otherTags2.forEach((tag: any) => {
			const [, name, content] = tag.match(/<meta\s+name='([^']+)'\s+content='([^']+)'\s*\/?>/)

			if (typeof name === "string" && typeof content === "string") {
				metadata["meta:" + name] = content
			}
		})
	}

	const titleMatch = response.data.match(/<title>([^<]+)<\/title>/)

	if (titleMatch && titleMatch[1] && typeof titleMatch[1] === "string") {
		metadata["title"] = titleMatch[1]
	}

	const faviconMatch = response.data.match(/<link\s+rel="icon"\s+href="([^"]+)"\s*\/?>/)
	const faviconMatch2 = response.data.match(/<link\s+rel='icon'\s+href='([^"]+)'\s*\/?>/)

	if (faviconMatch && faviconMatch[1] && typeof faviconMatch[1] === "string") {
		metadata["favicon"] = faviconMatch[1]
	}

	if (faviconMatch2 && faviconMatch2[1] && typeof faviconMatch2[1] === "string") {
		metadata["favicon"] = faviconMatch2[1]
	}

	return metadata
}
