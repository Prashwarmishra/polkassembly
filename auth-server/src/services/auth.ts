// Copyright 2019-2020 @Premiurly/polkassembly authors & contributors
// This software may be modified and distributed under the terms
// of the Apache-2.0 license. See the LICENSE file for details.

import { AuthenticationError, ForbiddenError, UserInputError } from 'apollo-server';
import * as argon2 from 'argon2';
import { randomBytes, timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';
import moment from 'moment';
import { uuid } from 'uuidv4';
import validator from 'validator';

import Address from '../model/Address';
import Notification from '../model/Notification';
import PostSubscription from '../model/PostSubscription';
import RefreshToken from '../model/RefreshToken';
import UndoEmailChangeToken from '../model/UndoEmailChangeToken';
import User from '../model/User';
import { redisDel, redisGet, redisSetex } from '../redis';
import { AuthObjectType, HashedPassword, JWTPayploadType, Network, NotificationPreferencesType, Role } from '../types';
import getMultisigAddress from '../utils/getMultisigAddress';
import getNetworkUserAddressInfoFromUserId from '../utils/getNetworkUserAddressInfoFromUserId';
import getNotificationPreferencesFromUserId from '../utils/getNotificationPreferencesFromUserId';
import getPublicKey from '../utils/getPublicKey';
import getUserFromUserId from '../utils/getUserFromUserId';
import getUserIdFromJWT from '../utils/getUserIdFromJWT';
import messages from '../utils/messages';
import nameBlacklist from '../utils/nameBlacklist';
import verifySignature from '../utils/verifySignature';
import {
	sendResetPasswordEmail,
	sendUndoEmailChangeEmail,
	sendVerificationEmail
} from './email';

process.env.JWT_PRIVATE_KEY = process.env.JWT_PRIVATE_KEY && process.env.JWT_PRIVATE_KEY.split('\\n').join('\n');
process.env.JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY && process.env.JWT_PUBLIC_KEY.split('\\n').join('\n');

const privateKey = process.env.NODE_ENV === 'test' ? process.env.JWT_PRIVATE_KEY_TEST : process.env.JWT_PRIVATE_KEY;
const jwtPublicKey = process.env.NODE_ENV === 'test' ? process.env.JWT_PUBLIC_KEY_TEST : process.env.JWT_PUBLIC_KEY;
const passphrase = process.env.NODE_ENV === 'test' ? process.env.JWT_KEY_PASSPHRASE_TEST : process.env.JWT_KEY_PASSPHRASE;

const SIX_MONTHS = 6 * 30 * 24 * 60 * 60 * 1000;
export const ONE_DAY = 24 * 60 * 60; // (expressed in seconds)
export const ADDRESS_LOGIN_TTL = 5 * 60; // 5 min (expressed in seconds)
const NOTIFICATION_DEFAULTS = {
	new_proposal: false,
	own_proposal: true,
	post_created: true,
	post_participated: true
};

export const getPwdResetTokenKey = (userId: number): string => `PRT-${userId}`;
export const getAddressLoginKey = (address: string): string => `ALN-${address}`;
export const getAddressSignupKey = (address: string): string => `ASU-${address}`;
export const getSetCredentialsKey = (address: string): string => `SCR-${address}`;
export const getEmailVerificationTokenKey = (token: string): string => `EVT-${token}`;
export const getMultisigAddressKey = (address: string): string => `MLA-${address}`;

export default class AuthService {
	public async GetUser (token: string): Promise<User> {
		const userId = getUserIdFromJWT(token, jwtPublicKey);

		return getUserFromUserId(userId);
	}

	private async createUser (email: string, newPassword: string, username: string, web3signup: boolean): Promise<User> {
		const { password, salt } = await this.getSaltAndHashedPassword(newPassword);

		const user = await User
			.query()
			.allowInsert('[email, email_verified, password, salt, username, web3signup]')
			.insert({
				email,
				email_verified: false,
				password,
				salt,
				username: username.toLowerCase(),
				web3signup
			});

		await Notification
			.query()
			.allowInsert('[user_id, post_participated, post_created, new_proposal, own_proposal]')
			.insert({
				user_id: user.id,
				...NOTIFICATION_DEFAULTS
			});

		return user;
	}

	private async createAddress (network: Network, address: string, defaultAddress: boolean, user_id: number): Promise<Address> {
		return Address
			.query()
			.allowInsert('[address, default, network, public_key, user_id, verified]')
			.insert({
				address,
				default: defaultAddress,
				network,
				public_key: getPublicKey(address),
				user_id,
				verified: true
			});
	}

	private async createAndSendEmailVerificationToken (user: User): Promise<void> {
		if (user.email) {
			const verifyToken = uuid();

			await redisSetex(getEmailVerificationTokenKey(verifyToken), ONE_DAY, user.email);

			// send verification email in background
			sendVerificationEmail(user, verifyToken);
		}
	}

	private async getSaltAndHashedPassword (plainPassword: string): Promise<HashedPassword> {
		const salt = randomBytes(32);
		const hashedPassword = await argon2.hash(plainPassword, { salt });

		return {
			password: hashedPassword,
			salt: salt.toString('hex')
		};
	}

	public async Login (username: string, password: string): Promise<AuthObjectType> {
		for (let i = 0; i < nameBlacklist.length; i++) {
			if (username.toLowerCase().includes(nameBlacklist[i])) {
				throw new ForbiddenError(messages.USERNAME_BANNED);
			}
		}

		const user = await User
			.query()
			.where('username', username.toLowerCase())
			.first();

		if (!user) {
			throw new AuthenticationError(messages.NO_USER_FOUND_WITH_USERNAME);
		}

		const correctPassword = await user.verifyPassword(password);
		if (!correctPassword) {
			throw new AuthenticationError(messages.INCORRECT_PASSWORD);
		}

		return {
			refreshToken: await this.getRefreshToken(user),
			token: await this.getSignedToken(user)
		};
	}

	public async DeleteAccount (token: string, password: string): Promise<void> {
		const userId = getUserIdFromJWT(token, jwtPublicKey);
		const user = await getUserFromUserId(userId);

		const correctPassword = await user.verifyPassword(password);
		if (!correctPassword) {
			throw new AuthenticationError(messages.INCORRECT_PASSWORD);
		}

		await Address
			.query()
			.where({
				user_id: user.id
			})
			.del();

		await PostSubscription
			.query()
			.where({
				user_id: user.id
			})
			.del();

		await RefreshToken
			.query()
			.where({
				user_id: user.id
			})
			.del();

		await UndoEmailChangeToken
			.query()
			.where({
				user_id: user.id
			})
			.del();

		const username = `deleted-${uuid()}`;
		const newPassword = uuid();
		const hashedPassword = await this.getSaltAndHashedPassword(newPassword);

		await User
			.query()
			.patch({
				email: '',
				email_verified: false,
				password: hashedPassword.password,
				salt: hashedPassword.salt,
				username
			})
			.findById(userId);
	}

	public async SetDefaultAddress (token: string, address: string): Promise<string> {
		const userId = getUserIdFromJWT(token, jwtPublicKey);
		const user = await getUserFromUserId(userId);

		const addresses = await Address
			.query()
			.where('user_id', user.id);

		let defaultAddressId = 0;
		const otherAddressIds: number[] = [];

		// Going through any linked address for this user
		// we store the id of the address we want to set as default
		addresses.forEach((dbAddress) => {
			if (dbAddress.address === address) {
				defaultAddressId = dbAddress.id;
			} else {
				otherAddressIds.push(dbAddress.id);
			}
		});

		if (!defaultAddressId) {
			throw new ForbiddenError(messages.ADDRESS_NOT_FOUND);
		}

		await Address
			.query()
			.patch({ default: true })
			.findById(defaultAddressId);

		// Mark any other address from the user as NOT default
		await Address
			.query()
			.patch({ default: false })
			.whereIn('id', otherAddressIds);

		return this.getSignedToken(user);
	}

	public async AddressLoginStart (address: string): Promise<string> {
		const signMessage = `<Bytes>${uuid()}</Bytes>`;

		await redisSetex(getAddressLoginKey(address), ADDRESS_LOGIN_TTL, signMessage);

		return signMessage;
	}

	public async AddressLogin (address: string, signature: string): Promise<AuthObjectType> {
		const signMessage = await redisGet(getAddressLoginKey(address));

		if (!signMessage) {
			throw new ForbiddenError(messages.ADDRESS_LOGIN_SIGN_MESSAGE_EXPIRED);
		}

		const isValidSr = verifySignature(signMessage, address, signature);

		if (!isValidSr) {
			throw new ForbiddenError(messages.ADDRESS_LOGIN_INVALID_SIGNATURE);
		}

		const addressObj = await Address
			.query()
			.where('address', address)
			.first();

		if (!addressObj) {
			throw new ForbiddenError(messages.ADDRESS_LOGIN_NOT_FOUND);
		}

		const user = await User
			.query()
			.findById(addressObj.user_id);

		if (!user) {
			throw new ForbiddenError(messages.ADDRESS_LOGIN_NOT_FOUND);
		}

		await redisDel(getAddressLoginKey(address));

		return {
			refreshToken: await this.getRefreshToken(user),
			token: await this.getSignedToken(user)
		};
	}

	public async AddressSignupStart (address: string): Promise<string> {
		const addressObj = await Address
			.query()
			.where('address', address)
			.first();

		if (addressObj) {
			throw new ForbiddenError(messages.ADDRESS_SIGNUP_ALREADY_EXISTS);
		}

		const signMessage = `<Bytes>${uuid()}</Bytes>`;

		await redisSetex(getAddressSignupKey(address), ADDRESS_LOGIN_TTL, signMessage);

		return signMessage;
	}

	public async AddressSignupConfirm (network: Network, address: string, signature: string): Promise<AuthObjectType> {
		const signMessage = await redisGet(getAddressSignupKey(address));

		if (!signMessage) {
			throw new ForbiddenError(messages.ADDRESS_SIGNUP_SIGN_MESSAGE_EXPIRED);
		}

		const isValidSr = verifySignature(signMessage, address, signature);

		if (!isValidSr) {
			throw new ForbiddenError(messages.ADDRESS_SIGNUP_INVALID_SIGNATURE);
		}

		const addressObj = await Address
			.query()
			.where('address', address)
			.first();

		if (addressObj) {
			throw new ForbiddenError(messages.ADDRESS_SIGNUP_ALREADY_EXISTS);
		}

		const username = uuid().split('-').join('').substring(0, 25);
		const password = uuid();

		const user = await this.createUser('', password, username, true);

		await this.createAddress(network, address, true, user.id);
		await redisDel(getAddressSignupKey(address));
		await this.createAndSendEmailVerificationToken(user);

		return {
			refreshToken: await this.getRefreshToken(user),
			token: await this.getSignedToken(user)
		};
	}

	public async Logout (token: string, refreshToken: string): Promise<void> {
		if (!refreshToken) {
			throw new AuthenticationError(messages.REFRESH_TOKEN_NOT_PROVIDED);
		}

		const refreshTokenObj = await RefreshToken
			.query()
			.where('token', refreshToken)
			.first();

		if (!refreshTokenObj) {
			throw new ForbiddenError(messages.NO_CORRESPONDING_REFRESH_TOKEN);
		}

		const userId = getUserIdFromJWT(token, jwtPublicKey);

		if (refreshTokenObj.user_id !== userId) {
			throw new AuthenticationError(messages.JWT_REFRESH_TOKEN_USER_MISMATCH);
		}

		await RefreshToken
			.query()
			.patch({ valid: false })
			.where({ token: refreshToken });
	}

	public async SignUp (email: string, password: string, username: string): Promise<AuthObjectType> {
		let existing = await User
			.query()
			.where('username', username.toLowerCase())
			.first();

		if (existing) {
			throw new ForbiddenError(messages.USERNAME_ALREADY_EXISTS);
		}

		for (let i = 0; i < nameBlacklist.length; i++) {
			if (username.toLowerCase().includes(nameBlacklist[i])) {
				throw new ForbiddenError(messages.USERNAME_BANNED);
			}
		}

		if (email) {
			existing = await User
				.query()
				.where('email', email)
				.first();
		}

		if (existing) {
			throw new ForbiddenError(messages.USER_EMAIL_ALREADY_EXISTS);
		}

		const user = await this.createUser(email, password, username, false);

		await this.createAndSendEmailVerificationToken(user);

		return {
			refreshToken: await this.getRefreshToken(user),
			token: await this.getSignedToken(user)
		};
	}

	public async RefreshToken (token: string): Promise<string> {
		const refreshToken = await RefreshToken
			.query()
			.where('token', token)
			.first();

		if (!refreshToken) {
			throw new ForbiddenError(messages.REFRESH_TOKEN_NOT_PROVIDED);
		}

		if (!refreshToken.valid) {
			throw new ForbiddenError(messages.INVALID_REFRESH_TOKEN);
		}

		if (new Date(refreshToken.expires).getTime() < Math.floor(Date.now() / 1000)) {
			throw new ForbiddenError(messages.REFRESH_TOKEN_EXPIRED);
		}

		const user = await User
			.query()
			.where('id', refreshToken.user_id)
			.first();

		if (!user) {
			throw new ForbiddenError(messages.USER_NOT_FOUND);
		}

		return this.getSignedToken(user);
	}

	public async ChangePassword (token: string, oldPassword: string, newPassword: string): Promise<void> {
		if (validator.equals(oldPassword, newPassword)) {
			throw new UserInputError(messages.OLD_AND_NEW_PASSWORD_MUST_DIFFER);
		}

		const userId = getUserIdFromJWT(token, jwtPublicKey);
		const user = await getUserFromUserId(userId);
		const correctPassword = await user.verifyPassword(oldPassword);

		if (!correctPassword) {
			throw new UserInputError(messages.INCORRECT_PASSWORD);
		}

		const { password, salt } = await this.getSaltAndHashedPassword(newPassword);

		await User
			.query()
			.patch({
				password,
				salt
			})
			.findById(userId);
	}

	public async AddressUnlink (token: string, address: string): Promise<string> {
		const userId = getUserIdFromJWT(token, jwtPublicKey);
		const user = await getUserFromUserId(userId);

		const dbAddress = await Address
			.query()
			.where({
				address,
				user_id: user.id
			})
			.first();

		if (!dbAddress) {
			throw new ForbiddenError(messages.ADDRESS_NOT_FOUND);
		}

		if (dbAddress.default) {
			throw new ForbiddenError(messages.ADDRESS_UNLINK_NOT_ALLOWED);
		}

		await Address
			.query()
			.where({
				address,
				user_id: user.id
			})
			.del();

		return this.getSignedToken(user);
	}

	public async AddressLinkConfirm (token: string, address_id: number, signature: string): Promise<string> {
		const userId = getUserIdFromJWT(token, jwtPublicKey);
		const user = await getUserFromUserId(userId);

		const dbAddress = await Address
			.query()
			.where('id', address_id)
			.first();

		if (!dbAddress) {
			throw new ForbiddenError(messages.ADDRESS_NOT_FOUND);
		}

		if (dbAddress.user_id !== user.id) {
			throw new ForbiddenError(messages.ADDRESS_USER_NOT_MATCHING);
		}

		const isValidSr = verifySignature(dbAddress.sign_message, dbAddress.address, signature);

		if (!isValidSr) {
			throw new ForbiddenError(messages.ADDRESS_LINKING_FAILED);
		}

		// If this linked address is the first address to be linked. Then set it as default.
		// querying other verified addresses of user to check the same.
		const otherAddresses = await Address
			.query()
			.where({
				user_id: userId,
				verified: true
			});

		const setAsDefault = otherAddresses.length === 0;

		await Address
			.query()
			.patch({
				default: setAsDefault,
				public_key: getPublicKey(dbAddress.address),
				verified: true
			})
			.findById(address_id);

		return this.getSignedToken(user);
	}

	public async MultisigAddressSignupStart (address: string): Promise<string> {
		const addressObj = await Address
			.query()
			.where('address', address)
			.first();

		if (addressObj) {
			throw new ForbiddenError(messages.MULTISIG_ADDRESS_ALREADY_EXISTS);
		}

		const signMessage = `<Bytes>${uuid()}</Bytes>`;

		await redisSetex(getMultisigAddressKey(address), ADDRESS_LOGIN_TTL, signMessage);

		return signMessage;
	}

	public async MultiSigAddressLinkConfirm (
		token: string,
		network: Network,
		address: string,
		addresses: string,
		ss58Prefix: number,
		threshold: number,
		signatory: string,
		signature: string
	): Promise<string> {
		const userId = getUserIdFromJWT(token, jwtPublicKey);
		const user = await getUserFromUserId(userId);

		const signMessage = await redisGet(getMultisigAddressKey(address));

		if (!signMessage) {
			throw new ForbiddenError(messages.MULTISIG_SIGN_MESSAGE_EXPIRED);
		}

		const signatories = addresses.split(',').map(address => address.trim()).filter(x => !!x);

		const multisigAddress = getMultisigAddress(signatories, ss58Prefix, threshold);

		if (address !== multisigAddress) {
			throw new ForbiddenError(messages.MULTISIG_NOT_MATCHING);
		}

		if (!signatories.includes(signatory)) {
			throw new ForbiddenError(messages.MULTISIG_NOT_ALLOWED);
		}

		const isValidSr = verifySignature(signMessage, signatory, signature);

		if (!isValidSr) {
			throw new ForbiddenError(messages.ADDRESS_LINKING_FAILED);
		}

		// If this linked address is the first address to be linked. Then set it as default.
		// querying other verified addresses of user to check the same.
		const otherAddresses = await Address
			.query()
			.where({
				user_id: userId,
				verified: true
			});

		const setAsDefault = otherAddresses.length === 0;

		await this.createAddress(network, address, setAsDefault, user.id);
		await redisDel(getMultisigAddressKey(address));

		return this.getSignedToken(user);
	}

	public async VerifyEmail (token: string): Promise<string> {
		const email = await redisGet(getEmailVerificationTokenKey(token));

		if (!email) {
			throw new AuthenticationError(messages.EMAIL_VERIFICATION_TOKEN_NOT_FOUND);
		}

		let user = await User
			.query()
			.where('email', email)
			.first();

		if (!user) {
			throw new AuthenticationError(messages.EMAIL_VERIFICATION_USER_NOT_FOUND);
		}

		await User
			.query()
			.patch({ email_verified: true })
			.findById(user.id);

		await redisDel(getEmailVerificationTokenKey(token));

		user = await getUserFromUserId(user.id);

		return this.getSignedToken(user);
	}

	public async ChangeNotificationPreference (token: string, { postParticipated, postCreated, newProposal, ownProposal }: NotificationPreferencesType): Promise<string> {
		const userId = getUserIdFromJWT(token, jwtPublicKey);
		const user = await getUserFromUserId(userId);
		let notification = await Notification
			.query()
			.where('user_id', user.id)
			.first();

		if (!notification) {
			notification = await Notification
				.query()
				.allowInsert('[user_id, post_participated, post_created, new_proposal, own_proposal]')
				.insert({
					user_id: user.id,
					...NOTIFICATION_DEFAULTS
				});
		}

		const update = {
			new_proposal: newProposal === undefined ? notification.new_proposal : newProposal,
			own_proposal: ownProposal === undefined ? notification.own_proposal : ownProposal,
			post_created: postCreated === undefined ? notification.post_created : postCreated,
			post_participated: postParticipated === undefined ? notification.post_participated : postParticipated
		};

		await Notification
			.query()
			.patch(update)
			.findById(notification.id);

		return this.getSignedToken(user);
	}

	public async resendVerifyEmailToken (token: string): Promise<void> {
		const userId = getUserIdFromJWT(token, jwtPublicKey);
		const user = await getUserFromUserId(userId);

		if (!user.email) {
			throw new UserInputError(messages.EMAIL_NOT_FOUND);
		}

		await this.createAndSendEmailVerificationToken(user);
	}

	public async SetCredentialsStart (address: string): Promise<string> {
		const addressObj = await Address
			.query()
			.where('address', address)
			.first();

		if (!addressObj) {
			throw new ForbiddenError(messages.ADDRESS_NOT_FOUND);
		}

		const signMessage = `<Bytes>${uuid()}</Bytes>`;

		await redisSetex(getSetCredentialsKey(address), ADDRESS_LOGIN_TTL, signMessage);

		return signMessage;
	}

	public async SetCredentialsConfirm (address: string, email: string, newPassword: string, signature: string, username: string): Promise<string> {
		const signMessage = await redisGet(getSetCredentialsKey(address));

		if (!signMessage) {
			throw new ForbiddenError(messages.SET_CREDENTIALS_SIGN_MESSAGE_EXPIRED);
		}

		const isValidSr = verifySignature(signMessage, address, signature);

		if (!isValidSr) {
			throw new ForbiddenError(messages.SET_CREDENTIALS_INVALID_SIGNATURE);
		}

		const addressObj = await Address
			.query()
			.where('address', address)
			.first();

		if (!addressObj) {
			throw new ForbiddenError(messages.ADDRESS_NOT_FOUND);
		}

		let existing = await User
			.query()
			.where('username', username.toLowerCase())
			.first();

		if (existing) {
			throw new ForbiddenError(messages.USERNAME_ALREADY_EXISTS);
		}

		if (email) {
			existing = await User
				.query()
				.where('email', email)
				.first();
		}

		if (existing) {
			throw new ForbiddenError(messages.USER_EMAIL_ALREADY_EXISTS);
		}

		const userId = addressObj.user_id;
		let user = await getUserFromUserId(userId);
		const { password, salt } = await this.getSaltAndHashedPassword(newPassword);

		await User
			.query()
			.patch({
				email,
				password,
				salt,
				username: username.toLowerCase(),
				web3signup: false
			})
			.findById(userId);

		user = await getUserFromUserId(userId);

		await this.createAndSendEmailVerificationToken(user);

		await redisDel(getSetCredentialsKey(address));

		return this.getSignedToken(user);
	}

	public async ChangeUsername (token: string, username: string, password: string): Promise<string> {
		const userId = getUserIdFromJWT(token, jwtPublicKey);
		const existing = await User
			.query()
			.where('username', username.toLowerCase())
			.first();

		if (existing) {
			throw new ForbiddenError(messages.USERNAME_ALREADY_EXISTS);
		}

		let user = await getUserFromUserId(userId);

		const correctPassword = await user.verifyPassword(password);
		if (!correctPassword) {
			throw new UserInputError(messages.INCORRECT_PASSWORD);
		}

		await User
			.query()
			.patch({
				username: username.toLowerCase()
			})
			.findById(userId);

		user = await getUserFromUserId(userId);

		return this.getSignedToken(user);
	}

	public async ChangeEmail (token: string, email: string, password: string): Promise<string> {
		const userId = getUserIdFromJWT(token, jwtPublicKey);

		if (email !== '') {
			const existing = await User
				.query()
				.where('email', email)
				.first();

			if (existing) {
				throw new ForbiddenError(messages.USER_EMAIL_ALREADY_EXISTS);
			}
		}

		let user = await getUserFromUserId(userId);

		const correctPassword = await user.verifyPassword(password);
		if (!correctPassword) {
			throw new UserInputError(messages.INCORRECT_PASSWORD);
		}

		const existingUndoToken = await UndoEmailChangeToken
			.query()
			.where({
				user_id: userId,
				valid: true
			})
			.orderBy('created_at', 'desc')
			.first();

		if (existingUndoToken) {
			const now = moment();
			const last = moment(existingUndoToken.created_at);

			const hours = moment.duration(now.diff(last)).asHours();

			if (hours < 48) {
				throw new ForbiddenError(messages.EMAIL_CHANGE_NOT_ALLOWED_YET);
			}
		}

		const undoToken = await UndoEmailChangeToken
			.query()
			.allowInsert('[token, user_id, email, valid]')
			.insert({
				email: user.email,
				token: uuid(),
				user_id: userId,
				valid: true
			});

		await User
			.query()
			.patch({
				email,
				email_verified: false
			})
			.findById(userId);

		user = await getUserFromUserId(userId);

		await this.createAndSendEmailVerificationToken(user);

		// send undo token in background
		sendUndoEmailChangeEmail(user, undoToken);

		return this.getSignedToken(user);
	}

	public async RequestResetPassword (email: string): Promise<void> {
		const user = await User
			.query()
			.where('email', email)
			.first();

		if (!user) {
			return;
		}

		const resetToken = uuid();

		await redisSetex(getPwdResetTokenKey(user.id), ONE_DAY, resetToken);

		sendResetPasswordEmail(user, resetToken);
	}

	public async ResetPassword (token: string, userId: number, newPassword: string): Promise<void> {
		const storedToken = await redisGet(getPwdResetTokenKey(userId));

		if (!storedToken) {
			throw new AuthenticationError(messages.PASSWORD_RESET_TOKEN_INVALID);
		}

		const isValid = timingSafeEqual(Buffer.from(token), Buffer.from(storedToken));

		if (!isValid) {
			throw new AuthenticationError(messages.PASSWORD_RESET_TOKEN_INVALID);
		}

		const { password, salt } = await this.getSaltAndHashedPassword(newPassword);

		await User
			.query()
			.patch({
				password,
				salt
			})
			.findById(Number(userId));

		await redisDel(getPwdResetTokenKey(userId));
	}

	public async UndoEmailChange (token: string): Promise<{email: string; updatedToken: string}> {
		const undoToken = await UndoEmailChangeToken
			.query()
			.where('token', token)
			.first();

		if (!undoToken) {
			throw new AuthenticationError(messages.EMAIL_UNDO_TOKEN_NOT_FOUND);
		}

		if (!undoToken.valid) {
			throw new AuthenticationError(messages.INVALID_EMAIL_UNDO_TOKEN);
		}

		await User
			.query()
			.patch({
				email: undoToken.email,
				email_verified: false
			})
			.findById(undoToken.user_id);

		await UndoEmailChangeToken
			.query()
			.patch({ valid: false })
			.findById(undoToken.id);

		const user = await getUserFromUserId(undoToken.user_id);

		return { email: user.email, updatedToken: await this.getSignedToken(user) };
	}

	private async getSignedToken ({ email, email_verified, id, username, web3signup }: User): Promise<string> {
		if (!privateKey) {
			const key = process.env.NODE_ENV === 'test' ? 'JWT_PRIVATE_KEY_TEST' : 'JWT_PRIVATE_KEY';
			throw new ForbiddenError(`${key} not set. Aborting.`);
		}

		if (!passphrase) {
			const key = process.env.NODE_ENV === 'test' ? 'JWT_KEY_PASSPHRASE_TEST' : 'JWT_KEY_PASSPHRASE';
			throw new ForbiddenError(`${key} not set. Aborting.`);
		}

		const networkUserAddressInfo = await getNetworkUserAddressInfoFromUserId(id);

		const notification = await getNotificationPreferencesFromUserId(id);

		const allowedRoles: Role[] = [Role.USER];
		let currentRole: Role = Role.USER;

		// if our user is the proposal bot, give additional role.
		if (id === Number(process.env.PROPOSAL_BOT_USER_ID)) {
			allowedRoles.push(Role.PROPOSAL_BOT);
			currentRole = Role.PROPOSAL_BOT;
		}

		const tokenContent: JWTPayploadType = {
			email,
			email_verified: email_verified || false,
			'https://hasura.io/jwt/claims': {
				'x-hasura-allowed-roles': allowedRoles,
				'x-hasura-default-role': currentRole,
				'x-hasura-kusama': `{${networkUserAddressInfo.kusama.addresses}}`,
				'x-hasura-kusama-default': networkUserAddressInfo.kusama.default || '',
				'x-hasura-polkadot': `{${networkUserAddressInfo.polkadot.addresses}}`,
				'x-hasura-polkadot-default': networkUserAddressInfo.polkadot.default || '',
				'x-hasura-user-email': email || '',
				'x-hasura-user-id': `${id}`
			},
			iat: Math.floor(Date.now() / 1000),
			notification,
			sub: `${id}`,
			username,
			web3signup: web3signup || false
		};

		return jwt.sign(
			tokenContent,
			{ key: privateKey, passphrase },
			{ algorithm: 'RS256', expiresIn: '1h' }
		);
	}

	private async getRefreshToken ({ id }: {id: number}): Promise<string> {
		const token = uuid();
		const user_id = id;
		const valid = true;
		const expires = new Date(Date.now() + SIX_MONTHS).toISOString(); // now + 6 months
		const refreshToken = await RefreshToken.query()
			.allowInsert('[token, user_id, valid, expires]')
			.insert({
				expires,
				token,
				user_id,
				valid
			});

		return refreshToken.token;
	}
}
