// uses `aa-testkit` testing framework for AA tests. Docs can be found here `https://github.com/valyakin/aa-testkit`
// `mocha` standard functions and `expect` from `chai` are available globally
// `Testkit`, `Network`, `Nodes` and `Utils` from `aa-testkit` are available globally too
const { expect } = require('chai')
const { promisify } = require('util')
const path = require('path')
const fs = require('fs')
const objectHash = require("ocore/object_hash.js");
const parseOjson = require('ocore/formula/parse_ojson').parse;

const { log } = console
//const log = () => { }

async function getAaAddress(aa_src) {
	return objectHash.getChash160(await promisify(parseOjson)(aa_src));
}

function round(n, precision) {
	return parseFloat(n.toPrecision(precision));
}


async function findParamToMatchAmount(target_amount, f) {
	
	let param_value = target_amount; // initial estimation
	let triedParamValues = {};

	let bestAbove = {
		distance: Infinity,
		required_amount: null,
		param_value: null,
	};

	let bestBelow = {
		distance: -Infinity,
		required_amount: null,
		param_value: null,
	};

	let prev_param_value;
	let prev_distance = Infinity;
	let prev_slope;
	let prev_required_amount;
	let count = 0;
	while (true) {
		count++;
		if (count > 100)
			throw Error(`too many iterations, target ${target_amount}, last ${required_amount}`)
		log(`${count}: trying value ${param_value}`);
		triedParamValues[param_value] = true;
		try {
			var { required_amount, res } = await f(param_value);
		}
		catch (e) {
			log(`value ${param_value} failed`, e);
			param_value = (param_value + (prev_param_value||0))/2;
			continue;
		}
		const distance = target_amount - required_amount;
		if (
			bestAbove.distance < Infinity && bestBelow.distance > -Infinity
			&& (distance > 0 && distance >= bestAbove.distance || distance < 0 && distance <= bestBelow.distance)
		) {
			log(`distance ${distance} out of best range, will try its middle`);
			param_value = (bestAbove.param_value + bestBelow.param_value) / 2;
			continue;
		}
		if (distance > 0 && distance < bestAbove.distance)
			bestAbove = { distance, required_amount, param_value };
		if (distance < 0 && distance > bestBelow.distance)
			bestBelow = { distance, required_amount, param_value };
		const approach = prev_distance / distance;
		const delta_param_value = param_value - prev_param_value;

		// 1st derivative
		let slope = prev_param_value ? (param_value - prev_param_value) / (required_amount - prev_required_amount) : param_value / required_amount;
	//	if (distance < 1000) // too noisy probably due to rounding
	//		slope = param_value / required_amount;
		
		log(`result`, { param_value, required_amount, res, distance, approach, delta_param_value, slope });
		if (required_amount === target_amount)
			return { res, required_amount, param_value };
		if (param_value === prev_param_value) {
			log(`would repeat value ${param_value}`);
			return { res, required_amount, param_value };
		}
		if (required_amount === prev_required_amount) {
			log(`repeated amount ${required_amount}`);
			return { res, required_amount, param_value };
		}

		prev_param_value = param_value;
		param_value += slope * (target_amount - required_amount);

		if (0 && prev_slope) { // 2nd term of Taylor series
			const second_derivative = (slope - prev_slope) / (required_amount - prev_required_amount);
			param_value += 1 / 2 * second_derivative * (target_amount - required_amount) ** 2;
			log('2nd derivative', 1 / 2 * second_derivative * (target_amount - required_amount) ** 2)
		}
	//	param_value = Math.round(param_value);
		if (triedParamValues[Math.round(param_value)]) // already tried, try the middle then
			param_value = Math.round((param_value + prev_param_value) / 2);
		if (triedParamValues[Math.round(param_value)])
			throw Error(`param value ${param_value} again, target ${target_amount}, last ${required_amount}`)
		
		if (param_value < 0) {
			log(`next param value would be negative ${param_value}, will half instead`)
			param_value = prev_param_value / 2;
		}

		prev_distance = distance;
		prev_slope = prev_required_amount && slope;
		prev_required_amount = required_amount;
	}
}


describe('Cyclic trades in the pool', function () {
	this.timeout(120000)

	before(async () => {

		const pool_lib = fs.readFileSync(path.join(__dirname, '../pool-lib.oscript'), 'utf8');
		const pool_lib_address = await getAaAddress(pool_lib);
		const pool_lib_by_price = fs.readFileSync(path.join(__dirname, '../pool-lib-by-price.oscript'), 'utf8');
		const pool_lib_by_price_address = await getAaAddress(pool_lib_by_price);
		let pool_base = fs.readFileSync(path.join(__dirname, '../pool.oscript'), 'utf8');
		pool_base = pool_base.replace(/\$pool_lib_aa = '\w{32}'/, `$pool_lib_aa = '${pool_lib_address}'`)
		pool_base = pool_base.replace(/\$pool_lib_by_price_aa = '\w{32}'/, `$pool_lib_by_price_aa = '${pool_lib_by_price_address}'`)
		const pool_base_address = await getAaAddress(pool_base);
		let factory = fs.readFileSync(path.join(__dirname, '../factory.oscript'), 'utf8');
		factory = factory.replace(/\$pool_base_aa = '\w{32}'/, `$pool_base_aa = '${pool_base_address}'`)

		this.network = await Network.create()
			.with.numberOfWitnesses(1)
			.with.asset({ ousd: {} })
			.with.asset({ obit: {} })
			.with.agent({ lbc: path.join(__dirname, '../linear-bonding-curve.oscript') })
			.with.agent({ pool_lib: path.join(__dirname, '../pool-lib.oscript') })
			.with.agent({ pool_lib_by_price: path.join(__dirname, '../pool-lib-by-price.oscript') })
			.with.agent({ pool_base })
			.with.agent({ governance_base: path.join(__dirname, '../governance.oscript') })
			.with.agent({ factory })
			.with.wallet({ alice: {base: 100e9, obit: 100e9, ousd: 10000e9} })
			.with.wallet({ bob: {base: 100e9, obit: 100e9, ousd: 10000e9} })
		//	.with.explorer()
			.run()
		
		console.log('--- agents\n', this.network.agent)
		this.ousd = this.network.asset.ousd
		this.obit = this.network.asset.obit
		this.alice = this.network.wallet.alice
		this.aliceAddress = await this.alice.getAddress()
		this.bob = this.network.wallet.bob
		this.bobAddress = await this.bob.getAddress()

		this.executeGetter = async (getter, args = []) => {
			const { result, error } = await this.alice.executeGetter({
				aaAddress: this.pool_aa,
				getter,
				args
			})
			expect(error).to.be.null
			return result
		}

		this.get_price = async (asset_label, bAfterInterest = true) => {
			return await this.executeGetter('get_price', [asset_label, 0, 0, bAfterInterest])
		}

		this.get_leveraged_price = async (asset_label, L) => {
			return await this.executeGetter('get_leveraged_price', [asset_label, L, true])
		}

		this.checkTotals = async (bAfterInterest) => {
			const totals = bAfterInterest
				? await this.executeGetter('get_total_balances', [true])
				: await this.executeGetter('get_total_balances')
		//	console.log('totals', totals)
			expect(totals.x.excess).to.be.closeTo(0, 0.1)
			expect(totals.y.excess).to.be.closeTo(0, 0.1)
		}

		this.checkBalancesLeverage = (balances, both) => {
			if (!balances)
				balances = this.balances
			if (this.pool_leverage === 1) {
				expect(balances.x).to.be.eq(balances.xn)
				expect(balances.y).to.be.eq(balances.yn)
			}
			else {
				const x_leverage = balances.x / balances.xn
				const y_leverage = balances.y / balances.yn
				const x_ratio = round(x_leverage / this.pool_leverage, 13)
				const y_ratio = round(y_leverage / this.pool_leverage, 13)
			//	console.log({x_ratio, y_ratio, x_leverage, y_leverage})
				const along_x = x_ratio === 1 && y_ratio <= 1
				const along_y = y_ratio === 1 && x_ratio <= 1
				if (both)
					expect(along_x && along_y).to.be.true
				else
					expect(along_x || along_y).to.be.true
			}
		}


		this.getLeveragedSellParams = async (in_amount, token, leverage, entry_price, address) => {
			const { res, required_amount, param_value } = await findParamToMatchAmount(in_amount, async delta_Xn => {
				const res = await this.executeGetter('get_leveraged_trade_amounts', [token, leverage, delta_Xn, entry_price, address])
				return { res, required_amount: -res.shares };
			});
			return { res, delta: param_value };
		}

	})

	it('Bob defines a new pool', async () => {
		const { error: tf_error } = await this.network.timefreeze()
		expect(tf_error).to.be.null
		
	//	this.x_asset = 'base'
		this.x_asset = this.obit
		this.y_asset = this.ousd
		this.base_interest_rate = 0//.3
		this.swap_fee = 0//.003
		this.exit_fee = 0//.005
		this.leverage_profit_tax = 0//.1
		this.arb_profit_tax = 0//.9
		this.alpha = 0.5
		this.beta = 1 - this.alpha
	//	this.mid_price = 100
	//	this.price_deviation = 1.3
		this.pool_leverage = 1
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.network.agent.factory,
			amount: 10000,
			data: {
				x_asset: this.x_asset,
				y_asset: this.y_asset,
				swap_fee: this.swap_fee,
				exit_fee: this.exit_fee,
				leverage_profit_tax: this.leverage_profit_tax,
				arb_profit_tax: this.arb_profit_tax,
				base_interest_rate: this.base_interest_rate,
				alpha: this.alpha,
				mid_price: this.mid_price,
				price_deviation: this.price_deviation,
				pool_leverage: this.pool_leverage,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		this.pool_aa = response.response.responseVars.address
		expect(this.pool_aa).to.be.validAddress

		const { vars } = await this.bob.readAAStateVars(this.pool_aa)
		this.governance_aa = vars.governance_aa
		this.shares_asset = vars.lp_shares.asset
		expect(this.shares_asset).to.be.validUnit

		this.linear_shares = 0
		this.issued_shares = 0
		this.coef = 1
		this.balances = { x: 0, y: 0, xn: 0, yn: 0 }
		this.profits = { x: 0, y: 0 }
		this.leveraged_balances = {}

		this.bounce_fees = this.x_asset !== 'base' && { base: [{ address: this.pool_aa, amount: 1e4 }] }
		this.bounce_fee_on_top = this.x_asset === 'base' ? 1e4 : 0

	})


	it('Alice adds liquidity', async () => {
		const x_amount = 1e9
		const y_amount = 100e9
		this.price = y_amount / x_amount
		const new_linear_shares = this.mid_price
			? Math.round(x_amount * this.mid_price ** this.beta * this.price_deviation / (this.price_deviation - 1))
			: Math.round(x_amount ** this.alpha * y_amount ** this.beta)
		this.balances.x += x_amount * this.pool_leverage
		this.balances.y += y_amount * this.pool_leverage
		this.balances.xn += x_amount
		this.balances.yn += y_amount
		const new_issued_shares = new_linear_shares
		this.linear_shares += new_linear_shares
		this.issued_shares += new_issued_shares
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.x_asset]: [{ address: this.pool_aa, amount: x_amount + this.bounce_fee_on_top }],
				[this.y_asset]: [{ address: this.pool_aa, amount: y_amount }],
				...this.bounce_fees
			},
			messages: [{
				app: 'data',
				payload: {
					buy_shares: 1,
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.shares_asset,
				address: this.aliceAddress,
				amount: new_issued_shares,
			},
		])

		this.recent = {
			last_ts: response.timestamp,
		}

		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.lp_shares.coef).to.be.eq(this.coef)
		expect(vars.balances).to.be.deep.eq(this.balances)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deep.eq(this.profits)
		expect(vars.recent).to.be.deep.eq(this.recent)

		const pool_value = this.balances.yn + this.price * this.balances.xn
		const share_price_in_y = pool_value / this.linear_shares
		console.log('pool value in y', pool_value / 1e9, { share_price_in_y })

		this.checkBalancesLeverage()
		await this.checkTotals()
	})


	it('Bob buys L-tokens', async () => {
	//	return;
		const x_change = 0.01e9
		const delta_Xn = this.pool_leverage === 1 ? -0.01e9 : -0.1e9
		const L = 5
		const result = await this.executeGetter('get_leveraged_trade_amounts', ['x', L, delta_Xn])
		console.log('L result', result)
		const { shares, net_delta, gross_delta, avg_share_price, arb_profit_tax, total_fee, balances, leveraged_balances, final_price } = result
		this.checkBalancesLeverage(balances)
		const added_fee = this.pool_leverage === 1 ? 0 : total_fee
		expect(balances.x).to.be.equalWithPrecision((this.balances.xn + delta_Xn + added_fee) * this.pool_leverage, 12)
		expect(balances.xn).to.be.equalWithPrecision(this.balances.xn + delta_Xn + added_fee, 12)
		expect(leveraged_balances[L + 'x'].supply).to.be.eq(shares)
		
		this.balances.x = balances.x
		this.balances.y = balances.y
		this.balances.xn += delta_Xn + added_fee
		this.balances.yn = balances.yn
		this.leveraged_balances = leveraged_balances
		if (this.pool_leverage === 1)
			this.profits.x += total_fee

		const { unit, error } = await this.bob.sendMulti({
			outputs_by_asset: {
				[this.x_asset]: [{address: this.pool_aa, amount: gross_delta + x_change}],
				...this.bounce_fees
			},
			messages: [{
				app: 'data',
				payload: {
					buy: 1,
				//	tokens: 1,
					L: L,
					asset: 'x',
					delta: -delta_Xn, // positive
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		this.recent.prev = false
		this.recent.current = {
			start_ts: Math.floor(response.timestamp / 3600) * 3600,
			pmin: 100,
			pmax: final_price,
		}
		this.recent.last_trade = {
			address: this.bobAddress,
			pmin: 100,
			pmax: final_price,
			amounts: { x: net_delta, y: 0 },
			paid_taxes: { x: arb_profit_tax, y: 0 },
		}

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.x_asset,
				address: this.bobAddress,
				amount: x_change,
			},
		])

		const { vars } = await this.bob.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.balances).to.be.deepCloseTo(this.balances, 0.1)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.0001)
		expect(vars.recent).to.be.deep.eq(this.recent)
		expect(vars['position_' + L + '_1']).to.be.deep.eq({
			owner: this.bobAddress,
			shares,
			price: avg_share_price,
			ts: unitObj.timestamp,
		})

		this.result = { x: -gross_delta, y: 0, l_shares: shares }

		this.checkBalancesLeverage()
		await this.checkTotals()
	})



	it('Bob swaps', async () => {
		// get the initial price
		const initial_price = await this.get_price('x')
		console.log({ initial_price })

		const { x0, y0, p_max, p_min } = await this.executeGetter('get_shifts_and_bounds')
		console.log({ x0, y0, p_max, p_min })

		const y_change = 1e9
		const final_price = initial_price * (this.mid_price ? 1.1 : 1.2)
		const result = await this.executeGetter('get_swap_amounts_by_final_price', ['y', final_price, 0, 0, this.bobAddress])
		console.log('swap result', result)
		const { in: y_amount, out: net_x_amount, arb_profit_tax, fees, balances, leveraged_balances } = result
		this.checkBalancesLeverage(balances)
		const x_amount = net_x_amount + fees.out
		const y_amount_sans_rounding_fee = y_amount - fees.in
		const avg_price = y_amount / x_amount
		expect(avg_price).to.be.gt(initial_price)
		expect(avg_price).to.be.lt(final_price)
		this.initial_y_investment = y_amount

		// simple calculation
		const unleveraged_x_amount = Math.floor((this.balances.x + x0) * (1 - (1 + y_amount / (this.balances.y + y0)) ** (-this.beta / this.alpha)))
	//	console.log({x_amount, unleveraged_x_amount})
		expect(unleveraged_x_amount).to.be.gt(x_amount)

		this.balances = balances
		this.leveraged_balances = leveraged_balances
		if (this.pool_leverage === 1) {
			this.profits.x += fees.out
			this.profits.y += fees.in
		}
		this.recent.current.pmax = final_price
		this.recent.last_trade.pmax = final_price
		this.recent.last_trade.amounts.x += x_amount
		this.recent.last_trade.paid_taxes.x += arb_profit_tax

		const { unit, error } = await this.bob.sendMulti({
			outputs_by_asset: {
				base: [{address: this.pool_aa, amount: 1e4}],
				[this.y_asset]: [{address: this.pool_aa, amount: y_amount + y_change}],
			},
			messages: [{
				app: 'data',
				payload: {
					final_price: final_price,
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	console.log('swap logs', JSON.stringify(response.logs, null, 2))

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.y_asset,
				address: this.bobAddress,
				amount: y_change,
			},
			{
				asset: this.x_asset,
				address: this.bobAddress,
				amount: net_x_amount,
			},
		])

		const { vars } = await this.bob.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.lp_shares.coef).to.be.equalWithPrecision(this.coef, 12)
		expect(vars.balances).to.be.deepCloseTo(this.balances, 0.1)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.001)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.001)

		this.balances = vars.balances

		// check the final price
		const price = await this.get_price('x')
		expect(price).to.be.equalWithPrecision(final_price, 9)
		this.price = price

		this.result.x += net_x_amount
		this.result.y -= y_amount
		console.log('bob result', this.result)

		const pool_value = this.balances.yn + this.price * this.balances.xn
		const share_price_in_y = pool_value / this.linear_shares
		console.log('pool value in y', pool_value / 1e9, { share_price_in_y })

		this.checkBalancesLeverage()
		await this.checkTotals()
	})


	it('Bob closes his leveraged position', async () => {
	//	return;
		const initial_price = await this.get_price('x')
		const initial_x5_leveraged_price = await this.get_leveraged_price('x', 5)
		console.log({ initial_price, initial_x5_leveraged_price })

		const { profits } = await this.executeGetter('get_balances_after_interest')
		this.profits = profits

		const L = 5
		const position_id = 'position_' + L + '_1'
		const { vars: old_vars } = await this.alice.readAAStateVars(this.pool_aa)
		const position = old_vars[position_id]
		console.log('position', position)

		const shares_to_sell = this.result.l_shares

		const { res, delta: delta_Xn } = await this.getLeveragedSellParams(shares_to_sell, 'x', L, position.price, this.bobAddress)
		const result = await this.executeGetter('get_leveraged_trade_amounts', ['x', L, delta_Xn, position.price, this.bobAddress])
		console.log('result', result)
		expect(result).to.be.deep.eq(res)
		const { shares, net_delta, gross_delta, avg_share_price, arb_profit_tax, total_fee, balances, leveraged_balances } = result
		expect(shares).to.be.eq(-shares_to_sell)
		this.checkBalancesLeverage(balances)
		const added_fee = this.pool_leverage === 1 ? 0 : total_fee
		expect(net_delta).to.be.lt(0)
		expect(gross_delta).to.be.lt(0)
		expect(shares).to.be.lt(0)
		expect(-shares).to.be.eq(position.shares)
		expect(balances.x).to.be.equalWithPrecision(this.balances.x + (delta_Xn + added_fee) * this.pool_leverage, 12)
		expect(balances.xn).to.be.equalWithPrecision(this.balances.xn + delta_Xn + added_fee, 12)
		expect(leveraged_balances[L + 'x'].supply).to.be.eq(this.leveraged_balances[L + 'x'].supply + shares)
		expect(avg_share_price).to.be.lt(initial_x5_leveraged_price)
		
		this.balances.x += (delta_Xn + added_fee) * this.pool_leverage
		this.balances.y = balances.y
		this.balances.xn += delta_Xn + added_fee
		this.balances.yn = balances.yn
		this.leveraged_balances = leveraged_balances
		if (this.pool_leverage === 1)
			this.profits.x += total_fee
		position.shares += shares
		
		this.recent.last_trade.amounts.x += -net_delta
		this.recent.last_trade.paid_taxes.x += arb_profit_tax

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.pool_aa,
			amount: 10000,
			data: {
				sell: 1,
				L: L,
				asset: 'x',
				delta: delta_Xn,
				position: position_id,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	await this.network.witnessUntilStable(response.response_unit)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.x_asset,
				address: this.bobAddress,
				amount: -gross_delta,
			},
		])

		const { vars } = await this.bob.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.balances).to.be.deepCloseTo(this.balances, 0.01)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.001)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.001)
		expect(vars[position_id]).to.be.undefined

		this.balances = vars.balances

		const final_price = await this.get_price('x')
		console.log({ final_price }, 'growth after closing L5', final_price / initial_price)
	//	const final_x5_leveraged_price = await this.get_leveraged_price('x', 5)
	//	console.log({ final_x5_leveraged_price }, 'growth after closing L5', final_x5_leveraged_price / initial_x5_leveraged_price, 'expected', (final_price / initial_price) ** (5 - 1))
	//	expect(final_x5_leveraged_price / initial_x5_leveraged_price).to.be.equalWithPrecision((final_price / initial_price) ** (5 - 1), 5)
	//	expect(avg_share_price).to.be.gt(final_x5_leveraged_price)

		this.result.x += -gross_delta
		this.result.l_shares -= -shares
		console.log('bob result', this.result)

		this.checkBalancesLeverage()
		await this.checkTotals()
	})


	it('Bob swaps the remaining x to y by delta x', async () => {
		const initial_price = await this.get_price('x')
		console.log({ initial_price })

		const { profits, balances: initial_balances, leveraged_balances: initial_leveraged_balances } = await this.executeGetter('get_balances_after_interest')
		this.profits = profits
	//	console.log('balances after interest', { initial_balances, initial_leveraged_balances })
		expect(initial_balances).to.be.deep.eq(this.balances)

		const { x0, y0, p_max, p_min } = await this.executeGetter('get_shifts_and_bounds')
		console.log({ x0, y0, p_max, p_min })

		const x_change = 0
		const delta_xn = this.result.x
		const result = await this.executeGetter('get_swap_amounts_by_delta_net_balance', ['x', delta_xn, 0, 0, this.bobAddress])
		console.log('swap result', result)
		const { in: x_amount, out: net_y_amount, arb_profit_tax, fees, balances, leveraged_balances, final_price: final_y_price } = result
		expect(x_amount).to.be.lte(delta_xn)
		this.checkBalancesLeverage(balances)
		if (this.pool_leverage === 1) {
			expect(balances.xn).to.be.equalWithPrecision(this.balances.xn + delta_xn, 12)
			this.profits.x += fees.in 
			this.profits.y += fees.out 
		}
		else
			expect(balances.xn).to.be.within(this.balances.xn + delta_xn, this.balances.xn + delta_xn + fees.in)
		expect(result.initial_price).to.be.equalWithPrecision(1/initial_price, 13)
		const y_amount = net_y_amount + fees.out
		const avg_price = x_amount / y_amount
		expect(avg_price).to.be.gt(1 / initial_price)
		expect(avg_price).to.be.lt(final_y_price)

		this.balances = balances
		this.leveraged_balances = leveraged_balances

		this.recent.last_trade.amounts.y += y_amount
		this.recent.last_trade.paid_taxes.y += arb_profit_tax

		const { unit, error } = await this.bob.sendMulti({
			outputs_by_asset: {
				[this.x_asset]: [{address: this.pool_aa, amount: x_amount + x_change}],
				...this.bounce_fees
			},
			messages: [{
				app: 'data',
				payload: {
					delta_xn: delta_xn,
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		await this.network.witnessUntilStable(response.response_unit)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.x_asset,
				address: this.bobAddress,
				amount: x_change,
			},
			{
				asset: this.y_asset,
				address: this.bobAddress,
				amount: net_y_amount,
			},
		])

		const { vars } = await this.bob.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.balances).to.be.deepCloseTo(this.balances, this.pool_leverage * this.price)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.001)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.001)

		// check the final price
		const final_price = await this.get_price('x')
		console.log({ final_price }, 'growth after swap', final_price / initial_price)
		expect(final_price).to.be.equalWithPrecision(1/final_y_price, 9)
		this.price = final_price

		this.result.x -= x_amount
		this.result.y += net_y_amount
		console.log('bob result', this.result, 'profit', this.result.y / this.initial_y_investment)
		console.log('bob balance', await this.bob.getBalance())

		const pool_value = this.balances.yn + this.price * this.balances.xn
		const share_price_in_y = pool_value / this.linear_shares
		console.log('pool value in y', pool_value / 1e9, { share_price_in_y })

		this.checkBalancesLeverage()
		await this.checkTotals()
	})


	it('Bob buys L-tokens again', async () => {
	//	return;
		const x_change = 0.01e9
		const delta_Xn = this.pool_leverage === 1 ? -0.01e9 : -0.1e9
		const L = 5
		const result = await this.executeGetter('get_leveraged_trade_amounts', ['x', L, delta_Xn, 0, this.bobAddress])
		console.log('L result', result)
		const { shares, net_delta, gross_delta, avg_share_price, arb_profit_tax, total_fee, balances, leveraged_balances } = result
		this.checkBalancesLeverage(balances)
		const added_fee = this.pool_leverage === 1 ? 0 : total_fee
		expect(balances.x).to.be.equalWithPrecision((this.balances.xn + delta_Xn + added_fee) * this.pool_leverage, 12)
		expect(balances.xn).to.be.equalWithPrecision(this.balances.xn + delta_Xn + added_fee, 12)
		expect(leveraged_balances[L + 'x'].supply).to.be.eq(shares)
		
		this.balances.x = balances.x
		this.balances.y = balances.y
		this.balances.xn += delta_Xn + added_fee
		this.balances.yn = balances.yn
		this.leveraged_balances = leveraged_balances
		if (this.pool_leverage === 1)
			this.profits.x += total_fee

		this.recent.last_trade.amounts.x += net_delta
		this.recent.last_trade.paid_taxes.x += arb_profit_tax

		const { unit, error } = await this.bob.sendMulti({
			outputs_by_asset: {
				[this.x_asset]: [{address: this.pool_aa, amount: gross_delta + x_change}],
				...this.bounce_fees
			},
			messages: [{
				app: 'data',
				payload: {
					buy: 1,
				//	tokens: 1,
					L: L,
					asset: 'x',
					delta: -delta_Xn, // positive
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	await this.network.witnessUntilStable(response.response_unit)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.x_asset,
				address: this.bobAddress,
				amount: x_change,
			},
		])

		const { vars } = await this.bob.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.balances).to.be.deepCloseTo(this.balances, 0.1)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.0001)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.001)
		expect(vars['position_' + L + '_2']).to.be.deep.eq({
			owner: this.bobAddress,
			shares,
			price: avg_share_price,
			ts: unitObj.timestamp,
		})

		this.result = { x: -gross_delta, y: 0, l_shares: shares }

		this.checkBalancesLeverage()
		await this.checkTotals()
	})


	after(async () => {
		// uncomment this line to pause test execution to get time for Obyte DAG explorer inspection
	//	await Utils.sleep(3600 * 1000)
		await this.network.stop()
	})
})
