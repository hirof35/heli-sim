import * as THREE from 'three';

// ==========================================
// 1. 入力管理クラス (Input Manager)
// ==========================================
interface HelicopterInput {
    pitch: number;
    roll: number;
    yaw: number;
    collective: number;
}

class InputManager {
    public state: HelicopterInput = { pitch: 0, roll: 0, yaw: 0, collective: 0.5 };
    private activeKeys: Set<string> = new Set();

    constructor() {
        window.addEventListener('keydown', (e) => this.activeKeys.add(e.key.toLowerCase()));
        window.addEventListener('keyup', (e) => this.activeKeys.delete(e.key.toLowerCase()));
    }

    public update(dt: number): void {
        const gamepad = navigator.getGamepads ? navigator.getGamepads()[0] : null;

        if (gamepad) {
            this.handleGamepad(gamepad);
        } else {
            this.handleKeyboard(dt);
        }
    }

    private handleKeyboard(dt: number): void {
        // ピッチ (前後)
        this.state.pitch = 0;
        if (this.activeKeys.has('arrowup'))   this.state.pitch = 1.0;
        if (this.activeKeys.has('arrowdown')) this.state.pitch = -1.0;

        // ロール (左右傾)
        this.state.roll = 0;
        if (this.activeKeys.has('arrowleft'))  this.state.roll = -1.0;
        if (this.activeKeys.has('arrowright')) this.state.roll = 1.0;

        // ヨー (旋回)
        this.state.yaw = 0;
        if (this.activeKeys.has('a')) this.state.yaw = -1.0;
        if (this.activeKeys.has('d')) this.state.yaw = 1.0;

        // コレクティブ (揚力)
        const changeSpeed = 0.5;
        if (this.activeKeys.has('w')) this.state.collective = Math.min(1.0, this.state.collective + changeSpeed * dt);
        if (this.activeKeys.has('s')) this.state.collective = Math.max(0.0, this.state.collective - changeSpeed * dt);
    }

    private handleGamepad(gamepad: Gamepad): void {
        const DEADZONE = 0.1;
        const applyDeadzone = (val: number) => Math.abs(val) < DEADZONE ? 0 : val;

        this.state.yaw = applyDeadzone(gamepad.axes[0]);
        const rawCollective = -gamepad.axes[1]; 
        this.state.collective = (rawCollective + 1.0) / 2.0;

        this.state.roll = applyDeadzone(gamepad.axes[2]);
        this.state.pitch = applyDeadzone(-gamepad.axes[3]);
    }
}

// ==========================================
// 2. 物理エンジンクラス (Helicopter Physics)
// ==========================================
class HelicopterPhysics {
    public position: THREE.Vector3 = new THREE.Vector3(0, 0, 0); // Y=0が地面
    public quaternion: THREE.Quaternion = new THREE.Quaternion();
    public velocity: THREE.Vector3 = new THREE.Vector3();
    public angularVelocity: THREE.Vector3 = new THREE.Vector3();

    public input: HelicopterInput = { pitch: 0, roll: 0, yaw: 0, collective: 0.5 };

    // 物理定数
    private readonly MASS = 1000;
    private readonly GRAVITY = 9.81;
    private readonly MAX_THRUST = 22000;
    private readonly DRAG_COEFF = 0.15; // 空気抵抗係数

    // 反トルク用定数
    private readonly MOI_YAW = 1500;
    private readonly MAX_MAIN_TORQUE = 3000;
    private readonly MAX_TAIL_THRUST = 4500;

    // 地面効果用定数
    private readonly ROTOR_RADIUS = 5.0;
    private readonly GROUND_HEIGHT = 1.0; // 機体中心から地面（着地時）までの高さ

    private getGroundEffectMultiplier(): number {
        const currentHeight = Math.max(this.GROUND_HEIGHT, this.position.y + this.GROUND_HEIGHT);
        const maxEffectHeight = this.ROTOR_RADIUS * 2;

        if (currentHeight >= maxEffectHeight) return 1.0;

        const heightRatio = currentHeight / maxEffectHeight;
        const bonus = 0.35 * Math.pow(1.0 - heightRatio, 2); 
        return 1.0 + bonus;
    }

    public update(dt: number): void {
        if (dt <= 0) return;

        // --- 1. 回転（姿勢）の演算 ---
        const mainRotorTorque = -this.input.collective * this.MAX_MAIN_TORQUE; // メインローターによる反トルク（左回転）
        const tailRotorTorque = this.input.yaw * this.MAX_TAIL_THRUST;       // テイルローターの打ち消し推力
        const totalYawTorque = mainRotorTorque + tailRotorTorque;

        // ヨー軸の角加速度と速度更新
        const yawAcceleration = totalYawTorque / this.MOI_YAW;
        this.angularVelocity.y += yawAcceleration * dt;
        this.angularVelocity.y *= Math.exp(-0.5 * dt); // 回転の自然空気抵抗

        // ピッチとロールは入力に直結（簡易化）
        const pitchSpeed = this.input.pitch * 1.2;
        const rollSpeed = this.input.roll * 1.5;

        // クォータニオンの乗算による姿勢更新
        const deltaQuaternion = new THREE.Quaternion();
        const euler = new THREE.Euler(pitchSpeed * dt, this.angularVelocity.y * dt, rollSpeed * dt, 'YXZ');
        deltaQuaternion.setFromEuler(euler);
        this.quaternion.multiply(deltaQuaternion);

        // --- 2. 座標（位置）の演算 ---
        const localUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quaternion);
        
        // 地面効果を含むメインローター総推力
        const baseThrust = this.input.collective * this.MAX_THRUST;
        const finalThrust = baseThrust * this.getGroundEffectMultiplier();
        const thrustForce = localUp.clone().multiplyScalar(finalThrust);

        // 重力
        const gravityForce = new THREE.Vector3(0, -this.MASS * this.GRAVITY, 0);

        // 空気抵抗 (速度の2乗に比例)
        const dragForce = this.velocity.clone().multiplyScalar(-this.DRAG_COEFF * this.velocity.length());

        // 合力から加速度、速度、位置を計算
        const totalForce = new THREE.Vector3().add(thrustForce).add(gravityForce).add(dragForce);
        const acceleration = totalForce.divideScalar(this.MASS);

        this.velocity.addScaledVector(acceleration, dt);
        this.position.addScaledVector(this.velocity, dt);

        // --- 3. 地面との衝突判定 (簡易着陸) ---
        if (this.position.y <= 0) {
            this.position.y = 0;
            if (this.velocity.y < -4.0) {
                console.warn("ハードランディング！機体が損傷しました: " + this.velocity.y.toFixed(2) + " m/s");
            }
            this.velocity.set(this.velocity.x * 0.8, 0, this.velocity.z * 0.8); // 着地時の摩擦減衰
            this.angularVelocity.set(0, 0, 0);
        }
    }
}

// ==========================================
// 3. スプリング追従カメラクラス (Chase Camera)
// ==========================================
class ChaseCamera {
    private camera: THREE.PerspectiveCamera;
    private idealOffset = new THREE.Vector3(0, 3.5, 9);  // 機体後方のカメラ位置
    private idealLookAt = new THREE.Vector3(0, 0.5, -3); // カメラが睨む前方位置
    private followSpeed = 6.0;

    constructor(camera: THREE.PerspectiveCamera) {
        this.camera = camera;
    }

    public update(targetPos: THREE.Vector3, targetQuat: THREE.Quaternion, dt: number): void {
        // 理想の世界座標カメラ位置を算出
        const targetCameraPos = this.idealOffset.clone().applyQuaternion(targetQuat).add(targetPos);
        // 滑らかに補間
        this.camera.position.lerp(targetCameraPos, this.followSpeed * dt);

        // 注視点の算出
        const targetLookAtPos = this.idealLookAt.clone().applyQuaternion(targetQuat).add(targetPos);
        this.camera.lookAt(targetLookAtPos);
    }
}

// ==========================================
// 4. アプリケーション本体・Three.jsの初期化とループ
// ==========================================
export class HelicopterApp {
    private scene!: THREE.Scene;
    private camera!: THREE.PerspectiveCamera;
    private renderer!: THREE.WebGLRenderer;
    private clock = new THREE.Clock();

    private physics = new HelicopterPhysics();
    private inputManager = new InputManager();
    private chaseCamera!: ChaseCamera;

    // 3Dオブジェクトの参照
    private heliGroup!: THREE.Group;
    private mainRotorMesh!: THREE.Mesh;
    private tailRotorMesh!: THREE.Mesh;

    constructor(canvasContainerId: string) {
        this.initThree(canvasContainerId);
        this.createEnvironment();
        this.createHelicopterMesh();
        this.animate();
    }

    private initThree(containerId: string): void {
        const container = document.getElementById(containerId)!;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x87ceeb); // 青空色
        this.scene.fog = new THREE.FogExp2(0x87ceeb, 0.01);

        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.chaseCamera = new ChaseCamera(this.camera);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.shadowMap.enabled = true;
        container.appendChild(this.renderer.domElement);

        // 光源
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
        this.scene.add(ambientLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(100, 300, 50);
        dirLight.castShadow = true;
        this.scene.add(dirLight);

        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }

    private createEnvironment(): void {
        // 地面
        const groundGeo = new THREE.PlaneGeometry(2000, 2000);
        const groundMat = new THREE.MeshStandardMaterial({ color: 0x557a46, roughness: 0.9 });
        const ground = new THREE.Mesh(groundGeo, groundMat);
        ground.rotation.x = -Math.PI / 2;
        ground.receiveShadow = true;
        this.scene.add(ground);

        // 滑走路/グリッド
        const grid = new THREE.GridHelper(200, 50, 0xff0000, 0x444444);
        grid.position.y = 0.01;
        this.scene.add(grid);
    }

    private createHelicopterMesh(): void {
        this.heliGroup = new THREE.Group();

        // 胴体 (コックピット)
        const bodyGeo = new THREE.BoxGeometry(1.2, 1.2, 2.5);
        const bodyMat = new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.5, roughness: 0.3 });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.castShadow = true;
        this.heliGroup.add(body);

        // テイルブーム (後ろの細い棒)
        const boomGeo = new THREE.CylinderGeometry(0.15, 0.08, 2.5);
        const boomMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
        const boom = new THREE.Mesh(boomGeo, boomMat);
        boom.rotation.x = Math.PI / 2;
        boom.position.set(0, 0.2, 1.8);
        boom.castShadow = true;
        this.heliGroup.add(boom);

        // メインローター軸 & 羽
        const rotorShaftGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.4);
        const shaft = new THREE.Mesh(rotorShaftGeo, boomMat);
        shaft.position.set(0, 0.8, 0);
        this.heliGroup.add(shaft);

        const mainRotorGeo = new THREE.BoxGeometry(9.0, 0.02, 0.2);
        const rotorMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
        this.mainRotorMesh = new THREE.Mesh(mainRotorGeo, rotorMat);
        this.mainRotorMesh.position.set(0, 1.0, 0);
        this.heliGroup.add(this.mainRotorMesh);

        // テイルローター (後ろの小さい羽)
        const tailRotorGeo = new THREE.BoxGeometry(0.02, 1.2, 0.08);
        this.tailRotorMesh = new THREE.Mesh(tailRotorGeo, rotorMat);
        this.tailRotorMesh.position.set(0.25, 0.4, 3.0);
        this.heliGroup.add(this.tailRotorMesh);

        // スキッド (ソリ脚)
        const skidGeo = new THREE.BoxGeometry(0.1, 0.1, 2.8);
        const skidMat = new THREE.MeshStandardMaterial({ color: 0x555555 });
        const skidL = new THREE.Mesh(skidGeo, skidMat);
        skidL.position.set(-0.6, -0.7, 0);
        const skidR = skidL.clone();
        skidR.position.x = 0.6;
        this.heliGroup.add(skidL, skidR);

        this.scene.add(this.heliGroup);
        
        // 初期位置を物理に合わせる
        this.physics.position.set(0, 0, 0);
    }

    private animate = (): void => {
        requestAnimationFrame(this.animate);

        const dt = Math.min(this.clock.getDelta(), 0.1); // スパイク対策のクランプ

        // 1. 入力の同期
        this.inputManager.update(dt);
        this.physics.input = this.inputManager.state;

        // 2. 物理演算の更新
        this.physics.update(dt);

        // 3. 3Dモデルへの座標・回転の反映
        this.heliGroup.position.copy(this.physics.position);
        this.heliGroup.quaternion.copy(this.physics.quaternion);

        // 4. ビジュアルエフェクト (ローターの回転アニメーション)
        // コレクティブ（出力）の高さに応じてローターを高速回転させる
        const rotorSpeed = this.physics.input.collective * 45;
        this.mainRotorMesh.rotation.y += rotorSpeed * dt;
        this.tailRotorMesh.rotation.x += (rotorSpeed * 1.5) * dt; // テイルはさらに高速

        // 5. カメラ追従の更新
        this.chaseCamera.update(this.physics.position, this.physics.quaternion, dt);

        // UI表示用の簡易ログ (HTML側に要素があれば更新)
        const hud = document.getElementById('hud');
        if (hud) {
            hud.innerHTML = `
                高度: ${this.physics.position.y.toFixed(1)} m<br>
                速度: ${(this.physics.velocity.length() * 3.6).toFixed(0)} km/h<br>
                出力: ${(this.physics.input.collective * 100).toFixed(0)} %<br>
                操作: W/S (出力) | A/D (旋回) | 矢印キー (傾き)
            `;
        }

        // 6. レンダリング
        this.renderer.render(this.scene, this.camera);
    }
}
// src/main.ts の一番最後に追加
new HelicopterApp('canvas-container');